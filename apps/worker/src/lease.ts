/**
 * One supervisor pass at a time.
 *
 * The daily schedule, `/supervise` and the supervise workflow all run the same pass, and `/vision`
 * offers a maker the way a pass does. Two at once read the same archive, find the same missing
 * markers, and queue the same classifications and pages twice, which is two model calls for one
 * answer (#10). So a pass first takes a lease: an object in the archive that one invocation
 * manages to write and the others find already there.
 *
 * Writes are conditional, so taking the lease is one step that only one caller can win: created
 * when there is none, or replaced when it has run out and nobody replaced it since it was read.
 * Checked against `wrangler dev`: a put whose condition fails stores nothing and answers null.
 */
export const LEASE_KEY = "supervision/lease.json";

/**
 * How long a lease lasts if nobody gives it back. Longer than a pass is waited for, the workflow's
 * fifteen minutes, so a pass is not joined halfway; short enough that one which died holding it
 * holds up the next for twenty minutes, not a day.
 */
export const LEASE_MS = 20 * 60 * 1000;

interface Lease {
  holder: string;
  until: number;
}

/** A pass is already running. The caller is told so rather than starting a second one. */
export class LeaseHeld extends Error {
  override name = "LeaseHeld";
}

/** The lease as it was written, so it can be given back only if it is still this holder's. */
export interface Taken {
  holder: string;
  etag: string;
}

/** Take the lease, or throw `LeaseHeld` saying until when somebody else has it. */
export async function takeLease(bucket: R2Bucket, now = Date.now()): Promise<Taken> {
  const holder = crypto.randomUUID();
  const lease = JSON.stringify({ holder, until: now + LEASE_MS } satisfies Lease);
  const current = await bucket.get(LEASE_KEY);
  let written: R2Object | null;
  if (current) {
    const held = await current.json<Lease>();
    if (held.until > now)
      throw new LeaseHeld(
        `a supervisor pass is running; its lease lasts until ${new Date(held.until).toISOString()}`,
      );
    written = await bucket.put(LEASE_KEY, lease, { onlyIf: { etagMatches: current.etag } });
  } else {
    written = await bucket.put(LEASE_KEY, lease, { onlyIf: { etagDoesNotMatch: "*" } });
  }
  if (!written) throw new LeaseHeld("another supervisor pass took the lease first");
  return { holder, etag: written.etag };
}

/**
 * Give the lease back by marking it run out, and only if it is still the one this holder wrote:
 * a lease that ran out and was taken by the next pass is that pass's now. A give-back that fails
 * is not worth failing the pass for, since the lease runs out by itself.
 */
export async function releaseLease(bucket: R2Bucket, taken: Taken): Promise<void> {
  try {
    await bucket.put(
      LEASE_KEY,
      JSON.stringify({ holder: taken.holder, until: 0 } satisfies Lease),
      {
        onlyIf: { etagMatches: taken.etag },
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "the supervisor lease was not given back; it runs out by itself",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Run `work` holding the lease, and give it back however the work ends. */
export async function underLease<T>(bucket: R2Bucket, work: () => Promise<T>): Promise<T> {
  const taken = await takeLease(bucket);
  try {
    return await work();
  } finally {
    await releaseLease(bucket, taken);
  }
}

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
 * How long a pass's lease lasts if nobody gives it back. Longer than any pass can run: the
 * schedule's invocation ends at fifteen minutes, the workflow stops waiting at fifteen, and
 * `just supervise` at thirty seconds, and a pass ends when its caller does. Short enough that one
 * which died holding it holds up the next for twenty minutes, not a day.
 */
export const LEASE_MS = 20 * 60 * 1000;

/** An offer of one maker to the page reader takes seconds, so it holds the lease a minute at most. */
export const OFFER_LEASE_MS = 60 * 1000;

/** What holds the lease: a whole pass, or one maker's offer to the page reader. */
export type Holder = "pass" | "offer";

interface Lease {
  holder: string;
  until: number;
  what?: Holder;
}

/** A pass or an offer is already running. The caller is told which, and until when. */
export class LeaseHeld extends Error {
  override name = "LeaseHeld";
  readonly what: Holder;
  readonly until: number;
  constructor(message: string, what: Holder, until: number) {
    super(message);
    this.what = what;
    this.until = until;
  }
}

/** The lease as it was written, so it can be given back only if it is still this holder's. */
export interface Taken {
  holder: string;
  etag: string;
}

const held = (lease: Lease): LeaseHeld => {
  const what = lease.what ?? "pass";
  const doing = what === "offer" ? "an offer to the page reader" : "a supervisor pass";
  return new LeaseHeld(
    `${doing} is running; its lease lasts until ${new Date(lease.until).toISOString()}`,
    what,
    lease.until,
  );
};

/** Take the lease, or throw `LeaseHeld` saying who has it and until when. */
export async function takeLease(
  bucket: R2Bucket,
  now = Date.now(),
  { what = "pass", ms = LEASE_MS }: { what?: Holder; ms?: number } = {},
): Promise<Taken> {
  const holder = crypto.randomUUID();
  const lease = JSON.stringify({ holder, until: now + ms, what } satisfies Lease);
  const current = await bucket.get(LEASE_KEY);
  let written: R2Object | null;
  if (current) {
    const found = await current.json<Lease>();
    if (found.until > now) throw held(found);
    written = await bucket.put(LEASE_KEY, lease, { onlyIf: { etagMatches: current.etag } });
  } else {
    written = await bucket.put(LEASE_KEY, lease, { onlyIf: { etagDoesNotMatch: "*" } });
  }
  if (!written) {
    // Somebody wrote it between the read and this write. Say who and until when, as for a lease
    // found held, unless the winner has already given it back.
    const winner = await (await bucket.get(LEASE_KEY))?.json<Lease>();
    if (winner && winner.until > now) throw held(winner);
    throw new LeaseHeld("another caller took the lease first and has given it back", what, now);
  }
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
export async function underLease<T>(
  bucket: R2Bucket,
  work: () => Promise<T>,
  holding: { what?: Holder; ms?: number } = {},
): Promise<T> {
  const taken = await takeLease(bucket, Date.now(), holding);
  try {
    return await work();
  } finally {
    await releaseLease(bucket, taken);
  }
}

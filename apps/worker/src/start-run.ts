import type { ManufacturerCrawlParams } from "./manufacturer-crawl.ts";
import type { PageCrawlParams } from "./page-crawl.ts";
import { newRun, type Pointer, pointerKey } from "./runs.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";

type Creation =
  | { kind: "maker"; params: ManufacturerCrawlParams }
  | { kind: "page"; params: PageCrawlParams }
  | { kind: "feed"; params: SellerCrawlParams };

interface Reservation extends Pointer {
  instance: string;
  creation?: Creation;
}

export class RunConflict extends Error {
  override name = "RunConflict";
}

export class RunStartUncertain extends Error {
  override name = "RunStartUncertain";
}

export function workflowOf(env: Env, id: string): Workflow {
  return id.startsWith("page-")
    ? env.PAGE_CRAWL
    : id.startsWith("maker-")
      ? env.MANUFACTURER_CRAWL
      : env.SELLER_CRAWL;
}

// Workflows retains completed IDs for at least three days with the default retention policy.
// Reconcile an unacknowledged creation only within one day; never let an expired ID run again.
// https://developers.cloudflare.com/workflows/build/workers-api/#createbatch
const RECOVERY_MS = 24 * 60 * 60 * 1000;

async function finishCreation(
  env: Env,
  key: string,
  pointer: Reservation,
  etag: string,
): Promise<string> {
  const { creation, ...accepted } = pointer;
  if (!creation) throw new RunConflict("No creation is reserved. Refresh and inspect the run.");
  const age = Date.now() - Date.parse(pointer.startedAt);
  if (!Number.isFinite(age) || age < 0 || age >= RECOVERY_MS)
    throw new RunConflict(
      `Creation of ${pointer.instance} is unconfirmed and too old to retry safely. Inspect it in Workflows before repairing the current pointer.`,
    );
  try {
    // Repeated calls use the saved ID AND parameters. createBatch skips an existing ID, even
    // when the first call committed but its response was lost. No second crawl is created.
    await workflowOf(env, pointer.instance).createBatch([
      { id: pointer.instance, params: creation.params },
    ]);
    await env.ARCHIVE.put(key, JSON.stringify(accepted), {
      onlyIf: { etagMatches: etag },
      httpMetadata: { contentType: "application/json" },
    });
    return pointer.instance;
  } catch {
    // Keep the reservation. Releasing it on a timeout would let a new ID duplicate this run.
    throw new RunStartUncertain(
      `Creation of ${pointer.instance} could not be confirmed. Refresh and inspect the run. Retrying within one day reconciles this same instance.`,
    );
  }
}

/**
 * Check the current workflow, then replace exactly the pointer checked. R2's conditional put
 * is the reservation: two callers may both see a completed run, but only one can replace it.
 * The pointer is visible before the workflow starts, and never expires while creation is
 * uncertain. Manual, bulk and scheduled starts must all enter here.
 */
async function start(env: Env, key: string, prepare: () => Reservation): Promise<string> {
  const current = await env.ARCHIVE.get(key);
  if (current) {
    const pointer = await current.json<Reservation>();
    if (pointer.creation) return finishCreation(env, key, pointer, current.etag);
    if (!pointer.instance)
      throw new RunConflict(
        "The current run has no workflow ID. Inspect it before starting another run.",
      );
    let status: InstanceStatus | undefined;
    try {
      status = await (await workflowOf(env, pointer.instance).get(pointer.instance)).status();
    } catch (error) {
      // The monthly schedule outlives Workflows retention. Only an explicit not-found for an
      // acknowledged, older instance permits a replacement; outages and pending creations do not.
      const expired = Date.now() - Date.parse(pointer.startedAt) >= 3 * RECOVERY_MS;
      if (!(expired && error instanceof Error && /\binstance\.not_found\b/.test(error.message)))
        throw new RunConflict(
          `The status of ${pointer.instance} is unavailable. Inspect it before starting another run.`,
        );
    }
    if (status && !["complete", "errored", "terminated"].includes(status.status))
      throw new RunConflict(
        `Workflow ${pointer.instance} is ${status.status}. Inspect it before starting another run.`,
      );
  }
  const reservation = prepare();
  const written = await env.ARCHIVE.put(key, JSON.stringify(reservation), {
    onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (!written)
    throw new RunConflict("Another caller changed the current run. Refresh and inspect it.");
  return finishCreation(env, key, reservation, written.etag);
}

export function startMaker(
  env: Env,
  manufacturerId: string,
  domains: string[],
  pageLimit?: number,
): Promise<string> {
  return start(env, pointerKey.documents(manufacturerId), () => {
    const run = newRun();
    const instance = `maker-${manufacturerId}-${run.id}`;
    return {
      run: run.id,
      date: run.date,
      instance,
      startedAt: new Date().toISOString(),
      creation: {
        kind: "maker",
        params: {
          instanceId: instance,
          run: run.id,
          manufacturerId,
          domains,
          checkedAt: run.date,
          ...(pageLimit === undefined ? {} : { pageLimit }),
        },
      },
    };
  });
}

export function startSeller(
  env: Env,
  sellerId: string,
  tier: "feed" | "page",
  limit?: number,
): Promise<string> {
  return start(env, pointerKey.sightings(sellerId), () => {
    const run = newRun();
    return {
      run: run.id,
      date: run.date,
      instance: tier === "feed" ? run.id : `page-${run.id}`,
      startedAt: new Date().toISOString(),
      creation: {
        kind: tier,
        params: {
          sellerId,
          run: run.id,
          checkedAt: run.date,
          ...(tier === "page" && limit !== undefined ? { limit } : {}),
        },
      },
    };
  });
}

/** One active entity must not stop a scheduled or bulk pass from reaching the others. */
export async function startIfFree(work: () => Promise<string>): Promise<string | undefined> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof RunConflict)) throw error;
    console.log(JSON.stringify({ message: "collection start skipped", reason: error.message }));
    return undefined;
  }
}

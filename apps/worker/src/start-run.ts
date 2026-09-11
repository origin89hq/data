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

export type StartResult =
  | { id: string; outcome: "created" }
  | { id: string; outcome: "reconciled"; status: InstanceStatus["status"] };

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
// https://developers.cloudflare.com/workflows/build/workers-api/#create
const RECOVERY_MS = 24 * 60 * 60 * 1000;

const missingInstance = (error: unknown): boolean =>
  error instanceof Error && /\binstance\.not_found\b/.test(error.message);

async function finishCreation(
  env: Env,
  key: string,
  pointer: Reservation,
  etag: string,
): Promise<StartResult> {
  const { creation, ...accepted } = pointer;
  if (!creation) throw new RunConflict("No creation is reserved. Refresh and inspect the run.");
  const workflow = workflowOf(env, pointer.instance);
  const exists = async () => {
    const instance = await workflow.get(pointer.instance);
    return instance.status();
  };
  let confirmed: InstanceStatus | undefined;
  try {
    try {
      // An acknowledged instance can be recovered even after the creation retry window. No
      // creation call is needed, and no duplicate-ID behavior is assumed.
      confirmed = await exists();
    } catch (error) {
      if (!missingInstance(error)) throw error;
      const age = Date.now() - Date.parse(pointer.startedAt);
      if (!Number.isFinite(age) || age < 0 || age >= RECOVERY_MS)
        throw new RunConflict(
          `Creation of ${pointer.instance} is unconfirmed and too old to retry safely. Inspect it in Workflows before repairing the current pointer.`,
        );
      try {
        await workflow.create({ id: pointer.instance, params: creation.params });
      } catch {
        // Another caller may have created this ID after our lookup, or creation may have
        // committed before the response was lost. Confirm it; never create a different ID.
        confirmed = await exists();
      }
    }
    await env.ARCHIVE.put(key, JSON.stringify(accepted), {
      onlyIf: { etagMatches: etag },
      httpMetadata: { contentType: "application/json" },
    });
    return confirmed
      ? { id: pointer.instance, outcome: "reconciled", status: confirmed.status }
      : { id: pointer.instance, outcome: "created" };
  } catch (error) {
    if (error instanceof RunConflict) throw error;
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
async function start(env: Env, key: string, prepare: () => Reservation): Promise<StartResult> {
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
      if (!(expired && missingInstance(error)))
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
  const result = await finishCreation(env, key, reservation, written.etag);
  // This request reserved a fresh run. Even if another caller helped create it, it belongs to
  // this pass; only a reservation read at entry can be a leftover from an earlier pass.
  return { id: result.id, outcome: "created" };
}

export function startMaker(
  env: Env,
  manufacturerId: string,
  domains: string[],
  pageLimit?: number,
): Promise<StartResult> {
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
): Promise<StartResult> {
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
export async function startIfFree(work: () => Promise<StartResult>): Promise<string | undefined> {
  try {
    let result = await work();
    if (
      result.outcome === "reconciled" &&
      ["complete", "errored", "terminated"].includes(result.status)
    )
      result = await work();
    // An active reconciliation is an existing run, not a newly started one. Retry a terminal
    // reconciliation only once; the same atomic guard handles a competing caller in between.
    return result.outcome === "created" ? result.id : undefined;
  } catch (error) {
    if (!(error instanceof RunConflict)) throw error;
    console.log(JSON.stringify({ message: "collection start skipped", reason: error.message }));
    return undefined;
  }
}

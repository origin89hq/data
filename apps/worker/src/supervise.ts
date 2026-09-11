import specPages from "../../../feeds/spec-pages.json" with { type: "json" };
import { noteActivity } from "./activity.ts";
import { classifyRun, convertRun, specPagesRun, visionRun } from "./enqueue.ts";
import { LeaseHeld, underLease } from "./lease.ts";
import { makerStates, previousPlan, sellerStates } from "./state.ts";

/**
 * Advance everything whose precondition is met, and say what it could not.
 *
 * The failure this answers is a pipeline that stops between its stages. Thirty-nine makers sat
 * with an approved plan and nothing to move them along, because every step was a call somebody had
 * to remember to make. A stage that can run on its own should.
 *
 * It never approves. Downloading somebody's documents is the one step that waits for a person, and
 * a supervisor that pressed that button would make the gate decorative.
 */
export interface SupervisionReport {
  at: string;
  /** Work started, and why it was ready. */
  started: { what: string; entity: string; detail: string }[];
  /** Work that cannot start, and what it is waiting for. */
  blocked: { entity: string; waitingOn: string }[];
  /** Things that look wrong rather than unfinished. */
  concerns: string[];
}

/**
 * Makers offered to the page reader in one pass. The pass is one invocation, and reading every
 * maker's state is already most of what an invocation may ask of R2; the first pass after the page
 * reader arrived would have added four calls for each of eighty-five makers at once. The rest are
 * reported as waiting and offered on the passes after.
 */
export const VISION_OFFERS_PER_PASS = 20;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One seller's or one maker's step. A step that throws is a concern about that entity, and the pass
 * goes on to the next. One seller's classification throwing once ended the whole pass: the sellers
 * after it, every maker, and the report that would have said what went wrong.
 */
async function step(
  report: SupervisionReport,
  what: string,
  entity: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    report.concerns.push(`${entity}: ${what} failed: ${reason(error)}`);
  }
}

/**
 * One pass, holding the supervisor's lease: a pass that finds it held throws `LeaseHeld` and
 * queues nothing, whether the schedule, the route or the workflow started it.
 */
export async function supervise(
  env: Env,
  today: string,
  by = "Scheduled supervisor",
): Promise<SupervisionReport> {
  return underLease(env.ARCHIVE, () => pass(env, today, by));
}

/**
 * The scheduled pass. One somebody started by hand is doing the same job, so this one steps aside
 * rather than fail: on a Monday the seller crawls start after it, and a refusal must not stop them.
 */
/** How long the scheduled pass waits out offers to the page reader before it steps aside. */
export const OFFERS_WAITED_MS = 3 * 60 * 1000;
/** How often it asks again while an offer holds the lease. */
export const OFFER_RETRY_MS = 5 * 1000;

export async function superviseIfFree(
  env: Env,
  today: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<SupervisionReport | undefined> {
  // An offer to the page reader holds the lease for seconds and does none of a pass's work, so the
  // day's pass waits for it rather than being skipped. The workflow offers makers one after
  // another, so it may wait out several; three minutes covers every converted maker.
  const deadline = Date.now() + OFFERS_WAITED_MS;
  for (;;) {
    try {
      return await supervise(env, today);
    } catch (error) {
      if (!(error instanceof LeaseHeld)) throw error;
      if (error.what === "offer" && Date.now() < deadline) {
        await sleep(OFFER_RETRY_MS);
        continue;
      }
      console.log(JSON.stringify({ message: "supervision skipped", reason: error.message }));
      return undefined;
    }
  }
}

async function pass(env: Env, today: string, by: string): Promise<SupervisionReport> {
  const passId = crypto.randomUUID();
  const report: SupervisionReport = {
    at: new Date().toISOString(),
    started: [],
    blocked: [],
    concerns: [],
  };

  for (const seller of await sellerStates(env.ARCHIVE)) {
    const date = seller.date;
    if (!date || !seller.sightings) continue;
    if (!seller.classified) {
      // A crawl that finished and was never classified. Listings already answered cost a read and
      // no model call, so re-running is cheap even when most of the shop is unchanged.
      await step(report, "classify", seller.seller, async () => {
        const { parts, sightings } = await classifyRun(env, seller.seller, date);
        report.started.push({
          what: "classify",
          entity: seller.seller,
          detail: `${parts} batches of ${sightings} listings`,
        });
      });
      continue;
    }
    const missing = seller.classified.parts - seller.classified.written;
    // A classification short of its own manifest is a run that died, not one still going: the
    // queue retries for minutes, not days, so a gap here is a gap that will not close itself.
    if (missing > 0)
      report.concerns.push(
        `${seller.seller} classified ${seller.classified.written} of ${seller.classified.parts} parts on ${seller.date}`,
      );
  }

  const pages = new Set(specPages.pages.map((p) => p.manufacturer));
  let offeredToVision = 0;
  for (const maker of await makerStates(env.ARCHIVE)) {
    const date = maker.date;
    if (!date) continue;

    // A maker's own specification pages need no approval: they are pages it publishes for people
    // to read, and a parser reads them. Only pages already adopted into the feed list are fetched.
    if (pages.has(maker.maker) && !maker.read) {
      await step(report, "spec-pages", maker.maker, async () => {
        const { pages: sent } = await specPagesRun(env, maker.maker, date, specPages.pages);
        if (sent > 0)
          report.started.push({
            what: "spec-pages",
            entity: maker.maker,
            detail: `${sent} pages the maker publishes`,
          });
      });
    }

    // The pointer moves when discovery starts, so a run that wrote no plan is either still reading
    // or died before it could say so. Only the workflow knows which, and only for a maker whose
    // run is silent is it asked (#48).
    if (maker.waitingOn === "discovery" && maker.instance) {
      const instance = maker.instance;
      await step(report, "discovery status", maker.maker, async () => {
        const status = await (await env.MANUFACTURER_CRAWL.get(instance)).status();
        // A run that ended, however it ended, and wrote no plan will never write one; left alone,
        // the maker waits on discovery for ever.
        if (["errored", "terminated", "complete"].includes(status.status))
          report.concerns.push(
            `${maker.maker}: discovery run ${instance} ${status.status === "complete" ? "completed" : status.status} without writing a plan${status.error?.message ? `: ${status.error.message}` : ""}`,
          );
      });
    }
    // An empty discovery becomes the current run like any other, and the figures pull leaves the
    // maker alone until something converts. What it must not do is pass unremarked when the run
    // before it had documents: that is a site that changed, or a crawl that was refused.
    if (maker.waitingOn !== "discovery" && maker.offered === 0 && maker.run) {
      const run = maker.run;
      await step(report, "discovery", maker.maker, async () => {
        const previous = await previousPlan(env.ARCHIVE, maker.maker, run);
        if (previous && previous.documents > 0)
          report.concerns.push(
            `${maker.maker}: discovery found no documents; the previous run ${previous.run} offered ${previous.documents}`,
          );
      });
    }

    if (maker.waitingOn.startsWith("somebody to approve")) {
      report.blocked.push({
        entity: maker.maker,
        waitingOn: `approval for ${maker.offered ?? 0} documents`,
      });
      continue;
    }
    // Approved and fetched, and nothing has started turning it into figures.
    if (maker.fetched && maker.converted === undefined) {
      await step(report, "convert", maker.maker, async () => {
        const { documents } = await convertRun(env, maker.maker, date);
        report.started.push({
          what: "convert",
          entity: maker.maker,
          detail: `${documents} approved documents`,
        });
      });
    }

    // Converted since the page reader last looked. A scan converts to page headings with nothing
    // under them, which the text reader reads as a document with nothing to say; this is the second
    // look. Offering a document the text reader already has costs one lookup and no model call.
    if (maker.converted !== undefined && maker.converted > (maker.seeing ?? 0)) {
      if (offeredToVision >= VISION_OFFERS_PER_PASS) {
        report.blocked.push({ entity: maker.maker, waitingOn: "its turn with the page reader" });
      } else {
        // Counted before the offer, so offers that fail still bound the pass.
        offeredToVision += 1;
        await step(report, "vision", maker.maker, async () => {
          const { documents } = await visionRun(env, maker.maker, date);
          report.started.push({
            what: "vision",
            entity: maker.maker,
            detail: `${documents} converted documents offered to the page reader`,
          });
        });
      }
    }
  }

  report.concerns.sort();
  await env.ARCHIVE.put(`supervision/${today}.json`, `${JSON.stringify(report, null, 2)}\n`, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.ARCHIVE.put("supervision/latest.json", `${JSON.stringify(report, null, 2)}\n`, {
    httpMetadata: { contentType: "application/json" },
  });
  console.log(
    JSON.stringify({
      message: "supervision finished",
      started: report.started.length,
      blocked: report.blocked.length,
      concerns: report.concerns.length,
    }),
  );
  await noteActivity(env.ARCHIVE, {
    id: `supervision:${passId}`,
    at: report.at,
    kind: "supervision",
    entity: "Supervisor",
    actor: by,
    summary:
      `${report.started.length} started · ${report.blocked.length} blocked · ${report.concerns.length} concerns${report.concerns.length ? ` · ${report.concerns[0]}` : ""}`.slice(
        0,
        1000,
      ),
  });
  return report;
}

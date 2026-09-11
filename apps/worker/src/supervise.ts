import specPages from "../../../feeds/spec-pages.json" with { type: "json" };
import { answeredInputs, classifyRun, convertRun, specPagesRun, visionRun } from "./enqueue.ts";
import { LeaseHeld, underLease } from "./lease.ts";
import { makerStates, sellerStates } from "./state.ts";

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
export async function supervise(env: Env, today: string): Promise<SupervisionReport> {
  return underLease(env.ARCHIVE, () => pass(env, today));
}

/**
 * The scheduled pass. One somebody started by hand is doing the same job, so this one steps aside
 * rather than fail: on a Monday the seller crawls start after it, and a refusal must not stop them.
 */
export async function superviseIfFree(
  env: Env,
  today: string,
): Promise<SupervisionReport | undefined> {
  try {
    return await supervise(env, today);
  } catch (error) {
    if (!(error instanceof LeaseHeld)) throw error;
    console.log(JSON.stringify({ message: "supervision skipped", reason: error.message }));
    return undefined;
  }
}

async function pass(env: Env, today: string): Promise<SupervisionReport> {
  const report: SupervisionReport = {
    at: new Date().toISOString(),
    started: [],
    blocked: [],
    concerns: [],
  };

  // Listed once for the pass, and only if a seller needs it. A listing that fails is left unset,
  // so the next seller lists again rather than taking the failure as nothing answered.
  let answered: Set<string> | undefined;
  for (const seller of await sellerStates(env.ARCHIVE)) {
    const date = seller.date;
    if (!date || !seller.sightings) continue;
    if (!seller.classified) {
      // A crawl that finished and was never classified. Listings already answered cost nothing,
      // so re-running is cheap even when most of the shop is unchanged.
      await step(report, "classify", seller.seller, async () => {
        answered ??= await answeredInputs(env.ARCHIVE);
        const { parts, alreadyAnswered } = await classifyRun(env, seller.seller, date, answered);
        report.started.push({
          what: "classify",
          entity: seller.seller,
          detail: `${parts} batches, ${alreadyAnswered} listings already answered`,
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
  return report;
}

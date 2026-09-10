import specPages from "../../../feeds/spec-pages.json" with { type: "json" };
import { classifyRun, convertRun, specPagesRun, visionRun } from "./enqueue.ts";
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

export async function supervise(env: Env, today: string): Promise<SupervisionReport> {
  const report: SupervisionReport = {
    at: new Date().toISOString(),
    started: [],
    blocked: [],
    concerns: [],
  };

  for (const seller of await sellerStates(env.ARCHIVE)) {
    if (!seller.date || !seller.sightings) continue;
    if (!seller.classified) {
      // A crawl that finished and was never classified. Listings already answered cost nothing,
      // so re-running is cheap even when most of the shop is unchanged.
      const { parts, alreadyAnswered } = await classifyRun(env, seller.seller, seller.date);
      report.started.push({
        what: "classify",
        entity: seller.seller,
        detail: `${parts} batches, ${alreadyAnswered} listings already answered`,
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
    if (!maker.date) continue;

    // A maker's own specification pages need no approval: they are pages it publishes for people
    // to read, and a parser reads them. Only pages already adopted into the feed list are fetched.
    if (pages.has(maker.maker) && !maker.read) {
      const { pages: sent } = await specPagesRun(env, maker.maker, maker.date, specPages.pages);
      if (sent > 0)
        report.started.push({
          what: "spec-pages",
          entity: maker.maker,
          detail: `${sent} pages the maker publishes`,
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
      const { documents } = await convertRun(env, maker.maker, maker.date);
      report.started.push({
        what: "convert",
        entity: maker.maker,
        detail: `${documents} approved documents`,
      });
    }

    // Converted since the page reader last looked. A scan converts to page headings with nothing
    // under them, which the text reader reads as a document with nothing to say; this is the second
    // look. Offering a document the text reader already has costs one lookup and no model call.
    if (maker.converted !== undefined && maker.converted > (maker.seeing ?? 0)) {
      if (offeredToVision >= VISION_OFFERS_PER_PASS) {
        report.blocked.push({ entity: maker.maker, waitingOn: "its turn with the page reader" });
      } else {
        const { documents } = await visionRun(env, maker.maker, maker.date);
        offeredToVision += 1;
        report.started.push({
          what: "vision",
          entity: maker.maker,
          detail: `${documents} converted documents offered to the page reader`,
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

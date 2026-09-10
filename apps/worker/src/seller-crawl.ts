import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Seller, Sighting } from "@origin89/equipment-schema/sighting";
import { fetchFeedPage, hasFeed, todayUtc } from "./feeds.ts";
import { pointerKey, runPrefix, writePointer } from "./runs.ts";
import { sellers } from "./sellers.ts";

export interface SellerCrawlParams {
  sellerId: string;
  /** The run this attempt writes under. */
  run: string;
  /** The crawl date, fixed at creation so every step agrees on it after a hibernation. */
  checkedAt: string;
}

/**
 * Hop one of the spider: one seller, one day, every product as printed. Each page is its own
 * step so a failed fetch retries alone, and each page lands in R2 under a key that a retry
 * simply rewrites. The manifest is written last, so a reader that finds one knows the run finished.
 */
export class SellerCrawl extends WorkflowEntrypoint<Env, SellerCrawlParams> {
  async run(event: WorkflowEvent<SellerCrawlParams>, step: WorkflowStep) {
    const { sellerId, run, checkedAt } = event.payload;
    const seller = Seller.parse(sellers.find((s) => s.id === sellerId));
    if (!hasFeed(seller))
      throw new Error(
        `${seller.id}: ${seller.platform} needs the page extractor, which is not written yet`,
      );
    // The path carries the run label; every sighting carries the day it was really seen.
    const seenOn = todayUtc();
    const prefix = runPrefix.sightings(seller.id, run);
    await step.do("become this seller's current run", () =>
      writePointer(this.env.ARCHIVE, pointerKey.sightings(seller.id), {
        run,
        date: checkedAt,
        instance: event.instanceId,
        startedAt: new Date().toISOString(),
      }),
    );
    const pages: { page: number; count: number }[] = [];

    for (let page = 1; ; page += 1) {
      const { sightings, last } = await step.do(
        `fetch page ${page}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
        () => fetchFeedPage(seller, page, seenOn),
      );
      for (const s of sightings) Sighting.parse(s);

      if (sightings.length > 0) {
        await step.do(`write page ${page}`, async () => {
          const lines = sightings.map((s) => JSON.stringify(s)).join("\n");
          await this.env.ARCHIVE.put(
            `${prefix}/page-${String(page).padStart(4, "0")}.jsonl`,
            `${lines}\n`,
            {
              httpMetadata: { contentType: "application/x-ndjson" },
            },
          );
        });
        pages.push({ page, count: sightings.length });
      }
      if (last || sightings.length === 0) break;
      await step.sleep(`politeness after page ${page}`, "2 seconds");
    }

    const total = pages.reduce((n, p) => n + p.count, 0);
    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(
        `${prefix}/manifest.json`,
        JSON.stringify(
          { seller: seller.id, checkedAt, retrievedAt: seenOn, pages, sightings: total },
          null,
          2,
        ),
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
    });
    console.log(
      JSON.stringify({
        message: "seller crawl finished",
        seller: seller.id,
        checkedAt,
        pages: pages.length,
        sightings: total,
      }),
    );
    return { seller: seller.id, checkedAt, pages: pages.length, sightings: total };
  }
}

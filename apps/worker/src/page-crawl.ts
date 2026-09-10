import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Seller, Sighting } from "@origin89/equipment-schema/sighting";
import { hasFeed, todayUtc } from "./feeds.ts";
import { sightingFromPage } from "./page-product.ts";
import { pointerKey, runPrefix, writePointer } from "./runs.ts";
import { sellers } from "./sellers.ts";
import {
  fetchText,
  isIndex,
  locations,
  pickProducts,
  pickSitemaps,
  sample,
  sitemapUrl,
} from "./sitemap.ts";

export interface PageCrawlParams {
  sellerId: string;
  /** The run this attempt writes under. */
  run: string;
  checkedAt: string;
  /** Try this many urls, spread evenly across the shop, instead of all of them. For checking a seller before letting the whole shop through. */
  limit?: number;
}

/** Pages per step. Small enough that a retry re-fetches little, large enough that a shop is not ten thousand steps. */
export const PAGE_BATCH = 25;

/**
 * Hop one for a seller with no product feed: discover product URLs from the sitemap, read each
 * page's own structured data, and keep what the page states about itself. A page that publishes
 * no product data yields nothing, which is the honest answer for a category or an article.
 */
export class PageCrawl extends WorkflowEntrypoint<Env, PageCrawlParams> {
  async run(event: WorkflowEvent<PageCrawlParams>, step: WorkflowStep) {
    const { sellerId, run, checkedAt, limit } = event.payload;
    const seller = Seller.parse(sellers.find((s) => s.id === sellerId));
    if (hasFeed(seller))
      throw new Error(`${seller.id} publishes a feed; use the feed crawl, which is exact`);
    // The path carries the run label; every sighting carries the day it was really seen.
    const seenOn = todayUtc();
    const prefix = runPrefix.sightings(seller.id, run);
    await step.do("become this seller's current run", () =>
      writePointer(this.env.ARCHIVE, pointerKey.sightings(seller.id), {
        run,
        date: checkedAt,
        // The id the instance was created with. A page crawl's is `page-` and the run, so the run
        // alone named an instance that does not exist.
        instance: event.instanceId,
        startedAt: new Date().toISOString(),
      }),
    );

    const found = await step.do(
      "discover product urls",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const root = await fetchText(sitemapUrl(seller));
        let urls = locations(root);
        if (isIndex(root)) {
          const collected: string[] = [];
          for (const child of pickSitemaps(seller, urls))
            collected.push(...locations(await fetchText(child)));
          urls = collected;
        }
        return pickProducts(seller, urls);
      },
    );
    // A shop with no product urls is a wrong sitemap or a wrong pattern, not a shop with no
    // products. Refusing names it; an empty manifest would read as a seller that stopped trading.
    if (found.urls.length === 0)
      throw new Error(
        `${seller.id}: no product urls from ${sitemapUrl(seller)}; check its sitemap and productPattern`,
      );
    const urls = limit ? sample(found.urls, limit) : found.urls;

    const pages: { batch: number; count: number }[] = [];
    const batches = Math.ceil(urls.length / PAGE_BATCH);
    let empty = 0;
    let failed = 0;
    for (let b = 0; b < batches; b += 1) {
      const slice = urls.slice(b * PAGE_BATCH, (b + 1) * PAGE_BATCH);
      const result = await step.do(
        `read pages ${b + 1} of ${batches}`,
        {
          retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
          timeout: "5 minutes",
        },
        async () => {
          const sightings: Sighting[] = [];
          let blank = 0;
          let errors = 0;
          for (const url of slice) {
            try {
              const sighting = sightingFromPage(seller, url, await fetchText(url), seenOn);
              if (sighting) sightings.push(Sighting.parse(sighting));
              else blank += 1;
            } catch {
              errors += 1;
            }
          }
          return { sightings, blank, errors };
        },
      );
      empty += result.blank;
      failed += result.errors;
      if (result.sightings.length > 0) {
        await step.do(`write pages ${b + 1}`, async () => {
          await this.env.ARCHIVE.put(
            `${prefix}/page-${String(b + 1).padStart(4, "0")}.jsonl`,
            `${result.sightings.map((s) => JSON.stringify(s)).join("\n")}\n`,
            {
              httpMetadata: { contentType: "application/x-ndjson" },
            },
          );
        });
        pages.push({ batch: b + 1, count: result.sightings.length });
      }
      if (b + 1 < batches) await step.sleep(`politeness after batch ${b + 1}`, "3 seconds");
    }

    const total = pages.reduce((n, p) => n + p.count, 0);
    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(
        `${prefix}/manifest.json`,
        JSON.stringify(
          {
            seller: seller.id,
            checkedAt,
            retrievedAt: seenOn,
            tier: "page",
            urls: urls.length,
            capped: found.capped,
            pages: pages.map((p) => ({ page: p.batch, count: p.count })),
            sightings: total,
            withoutProductData: empty,
            unreachable: failed,
          },
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
        message: "page crawl finished",
        seller: seller.id,
        checkedAt,
        urls: urls.length,
        sightings: total,
        withoutProductData: empty,
        unreachable: failed,
      }),
    );
    return {
      seller: seller.id,
      checkedAt,
      urls: urls.length,
      sightings: total,
      withoutProductData: empty,
      unreachable: failed,
    };
  }
}

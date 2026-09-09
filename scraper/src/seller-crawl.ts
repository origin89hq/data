import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Seller, Sighting } from "../../schema/sighting.ts";
import { sellers } from "./sellers.ts";
import { shopifyPageUrl, sightingsFromShopify, SHOPIFY_PAGE_SIZE, type ShopifyProduct } from "./shopify.ts";

export interface SellerCrawlParams {
  sellerId: string;
  /** The crawl date, fixed at creation so every step agrees on it after a hibernation. */
  checkedAt: string;
}

/** Who we are when we knock. A crawler that cannot be contacted is one that gets blocked. */
export const USER_AGENT = "offgrid-equipment/0.0 (+https://github.com/origin89hq/offgrid-equipment; hello@origin89.com)";

/**
 * Hop one of the spider: one seller, one day, every product as printed. Each page is its own
 * step so a failed fetch retries alone, and each page lands in R2 under a key that a retry
 * simply rewrites. The manifest is written last, so a reader that finds one knows the run finished.
 */
export class SellerCrawl extends WorkflowEntrypoint<Env, SellerCrawlParams> {
  async run(event: WorkflowEvent<SellerCrawlParams>, step: WorkflowStep) {
    const { sellerId, checkedAt } = event.payload;
    const seller = Seller.parse(sellers.find((s) => s.id === sellerId));
    const prefix = `sightings/${seller.id}/${checkedAt}`;
    const pages: { page: number; count: number }[] = [];

    for (let page = 1; ; page += 1) {
      const sightings = await step.do(
        `fetch page ${page}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
        async () => {
          const response = await fetch(shopifyPageUrl(seller, page), { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
          if (!response.ok) throw new Error(`${seller.id} page ${page}: HTTP ${response.status}`);
          const body = (await response.json()) as { products?: ShopifyProduct[] };
          return sightingsFromShopify(seller, body.products ?? [], checkedAt);
        },
      );
      if (sightings.length === 0) break;
      for (const s of sightings) Sighting.parse(s);

      await step.do(`write page ${page}`, async () => {
        const lines = sightings.map((s) => JSON.stringify(s)).join("\n");
        await this.env.ARCHIVE.put(`${prefix}/page-${String(page).padStart(4, "0")}.jsonl`, `${lines}\n`, {
          httpMetadata: { contentType: "application/x-ndjson" },
        });
      });
      pages.push({ page, count: sightings.length });

      const products = new Set(sightings.map((s) => s.productId)).size;
      if (products < SHOPIFY_PAGE_SIZE) break;
      await step.sleep(`politeness after page ${page}`, "2 seconds");
    }

    const total = pages.reduce((n, p) => n + p.count, 0);
    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(`${prefix}/manifest.json`, JSON.stringify({ seller: seller.id, checkedAt, pages, sightings: total }, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
    });
    console.log(JSON.stringify({ message: "seller crawl finished", seller: seller.id, checkedAt, pages: pages.length, sightings: total }));
    return { seller: seller.id, checkedAt, pages: pages.length, sightings: total };
  }
}

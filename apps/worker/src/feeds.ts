import type { Seller, Sighting } from "@origin89/equipment-schema/sighting";
import {
  SHOPIFY_PAGE_SIZE,
  type ShopifyProduct,
  shopifyPageUrl,
  sightingsFromShopify,
} from "./shopify.ts";
import { sightingsFromWoo, WOO_PAGE_SIZE, type WooProduct, wooPageUrl } from "./woocommerce.ts";

/** Who we are when we knock. A crawler that cannot be contacted is one that gets blocked. */
/**
 * The day this actually ran, taken from the clock rather than from the run's label. The label is
 * a name for a run and people pick names loosely; a date somebody reads as "when this was
 * fetched" has to be true, and 148 source records once claimed a day that had not happened.
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Empty a run's prefix before it writes. A run is one crawl of one seller or maker on one day,
 * and running it again replaces it — the shop's stock today is today's answer, not today's added
 * to this morning's. Without this a second run leaves the first's objects behind and the two read
 * as one, which is how two crawls of EPEver became a single prefix holding both.
 */
export async function clearPrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let removed = 0;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) return removed;
    await bucket.delete(page.objects.map((o) => o.key));
    removed += page.objects.length;
    if (!page.truncated) return removed;
  }
}

export const USER_AGENT =
  "offgrid-equipment/0.0 (+https://github.com/origin89hq/offgrid-equipment; hello@origin89.com)";

export interface FeedPage {
  sightings: Sighting[];
  /** True when this page is the last one, by the feed's own signal. */
  last: boolean;
}

/** Whether the platform publishes a product feed; the others go through the page tier. */
export function hasFeed(seller: Seller): boolean {
  switch (seller.platform) {
    case "shopify":
    case "woocommerce":
      return true;
    case "bigcommerce":
    case "magento":
    case "other":
      return false;
  }
}

/** Fetch one page of a seller's product feed. Throws on a non-2xx so the step retries. */
export async function fetchFeedPage(
  seller: Seller,
  page: number,
  checkedAt: string,
): Promise<FeedPage> {
  const headers = { "user-agent": USER_AGENT, accept: "application/json" };
  switch (seller.platform) {
    case "shopify": {
      const response = await fetch(shopifyPageUrl(seller, page), { headers });
      if (!response.ok) throw new Error(`${seller.id} page ${page}: HTTP ${response.status}`);
      const body = (await response.json()) as { products?: ShopifyProduct[] };
      const products = body.products ?? [];
      return {
        sightings: sightingsFromShopify(seller, products, checkedAt),
        last: products.length < SHOPIFY_PAGE_SIZE,
      };
    }
    case "woocommerce": {
      const response = await fetch(wooPageUrl(seller, page), { headers });
      if (!response.ok) throw new Error(`${seller.id} page ${page}: HTTP ${response.status}`);
      const products = (await response.json()) as WooProduct[];
      const totalPages = Number(response.headers.get("x-wp-totalpages") ?? "0");
      return {
        sightings: sightingsFromWoo(seller, products, checkedAt),
        last: products.length < WOO_PAGE_SIZE || (totalPages > 0 && page >= totalPages),
      };
    }
    case "bigcommerce":
    case "magento":
    case "other":
      throw new Error(`${seller.id}: ${seller.platform} has no product feed`);
  }
}

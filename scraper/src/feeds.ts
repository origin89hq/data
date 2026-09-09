import type { Seller, Sighting } from "../../schema/sighting.ts";
import { shopifyPageUrl, sightingsFromShopify, SHOPIFY_PAGE_SIZE, type ShopifyProduct } from "./shopify.ts";
import { sightingsFromWoo, wooPageUrl, WOO_PAGE_SIZE, type WooProduct } from "./woocommerce.ts";

/** Who we are when we knock. A crawler that cannot be contacted is one that gets blocked. */
export const USER_AGENT = "offgrid-equipment/0.0 (+https://github.com/origin89hq/offgrid-equipment; hello@origin89.com)";

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
export async function fetchFeedPage(seller: Seller, page: number, checkedAt: string): Promise<FeedPage> {
  const headers = { "user-agent": USER_AGENT, accept: "application/json" };
  switch (seller.platform) {
    case "shopify": {
      const response = await fetch(shopifyPageUrl(seller, page), { headers });
      if (!response.ok) throw new Error(`${seller.id} page ${page}: HTTP ${response.status}`);
      const body = (await response.json()) as { products?: ShopifyProduct[] };
      const products = body.products ?? [];
      return { sightings: sightingsFromShopify(seller, products, checkedAt), last: products.length < SHOPIFY_PAGE_SIZE };
    }
    case "woocommerce": {
      const response = await fetch(wooPageUrl(seller, page), { headers });
      if (!response.ok) throw new Error(`${seller.id} page ${page}: HTTP ${response.status}`);
      const products = (await response.json()) as WooProduct[];
      const totalPages = Number(response.headers.get("x-wp-totalpages") ?? "0");
      return { sightings: sightingsFromWoo(seller, products, checkedAt), last: products.length < WOO_PAGE_SIZE || (totalPages > 0 && page >= totalPages) };
    }
    case "bigcommerce":
    case "magento":
    case "other":
      throw new Error(`${seller.id}: ${seller.platform} has no product feed`);
  }
}

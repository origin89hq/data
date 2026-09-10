import type { Seller } from "@origin89/equipment-schema/sighting";
import { USER_AGENT } from "./feeds.ts";

/**
 * How many URLs one crawl will take from a seller. A shop with more than this is not truncated
 * silently: the manifest records that the list was capped, so a short run is visible as a short
 * run rather than read as a shop that shrank.
 */
export const MAX_URLS = 5000;

/** How many nested sitemaps to follow. An index of indexes is legal and is also how a crawl runs away. */
export const MAX_SITEMAPS = 40;

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/** Every `<loc>` in a sitemap or sitemap index, with XML entities decoded. */
export function locations(xml: string): string[] {
  return [...xml.matchAll(LOC)].map((m) =>
    m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'"),
  );
}

/** A sitemap index points at more sitemaps; a urlset points at pages. The tag says which. */
export function isIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

export function sitemapUrl(seller: Seller): string {
  return seller.sitemapUrl ?? `${seller.url.replace(/\/$/, "")}/sitemap.xml`;
}

/** Which of a sitemap index's entries are worth opening: the ones a seller's pattern names, or all of them. */
export function pickSitemaps(seller: Seller, urls: string[]): string[] {
  const pattern = seller.sitemapPattern ? new RegExp(seller.sitemapPattern, "i") : undefined;
  return (pattern ? urls.filter((u) => pattern.test(u)) : urls).slice(0, MAX_SITEMAPS);
}

/** Which page URLs are products. Without a pattern every page is tried, and the ones that publish no product yield nothing. */
export function pickProducts(seller: Seller, urls: string[]): { urls: string[]; capped: boolean } {
  const pattern = seller.productPattern ? new RegExp(seller.productPattern, "i") : undefined;
  const matched = [...new Set(pattern ? urls.filter((u) => pattern.test(u)) : urls)];
  return { urls: matched.slice(0, MAX_URLS), capped: matched.length > MAX_URLS };
}

/**
 * Take `limit` urls spread evenly across the list rather than the first `limit`. A sitemap is
 * usually ordered — NAZ lists every category before any product — so a prefix sample says what
 * the top of the sitemap holds, not what the shop sells, and a smoke test of it found nothing.
 */
export function sample(urls: string[], limit: number): string[] {
  if (limit <= 0 || urls.length <= limit) return urls;
  const stride = urls.length / limit;
  return Array.from({ length: limit }, (_, i) => urls[Math.floor(i * stride)]);
}

export async function fetchText(
  url: string,
  accept = "text/html,application/xhtml+xml,application/xml",
): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.text();
}

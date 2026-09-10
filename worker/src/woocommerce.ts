import type { Seller, Sighting } from "../../schema/sighting.ts";

/** The subset of a WooCommerce Store API product the spider reads. */
export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  sku?: string;
  type?: string;
  prices?: { price?: string; currency_code?: string; currency_minor_unit?: number };
  brands?: { name: string }[];
  categories?: { name: string }[];
  tags?: { name: string }[];
  attributes?: { name: string; taxonomy?: string | null; terms?: { name: string }[] }[];
  is_in_stock?: boolean;
}

/** The Store API caps a page at 100; the total page count arrives in the `X-WP-TotalPages` header. */
export const WOO_PAGE_SIZE = 100;

export function wooPageUrl(seller: Seller, page: number): string {
  return `${seller.url.replace(/\/$/, "")}/wp-json/wc/store/v1/products?per_page=${WOO_PAGE_SIZE}&page=${page}`;
}

/**
 * One sighting per product. A variable product's variations carry their own prices behind one
 * more request each, so the parent is recorded with its price as the store reports it and no
 * variant label; the variations are a later refinement, not a reason to drop the listing.
 */
export function sightingsFromWoo(seller: Seller, products: WooProduct[], checkedAt: string): Sighting[] {
  return products.map((p) => {
    const brandAttr = p.attributes?.find((a) => /^brand$/i.test(a.name) || a.taxonomy === "pa_brand")?.terms?.[0]?.name;
    const brand = p.brands?.[0]?.name ?? brandAttr;
    const model = p.attributes?.find((a) => /model/i.test(a.name))?.terms?.[0]?.name;
    const minor = p.prices?.currency_minor_unit ?? 2;
    const price = p.prices?.price !== undefined && /^\d+$/.test(p.prices.price) ? minorToDecimal(p.prices.price, minor) : undefined;
    const tags = (p.tags ?? []).map((t) => t.name).filter(Boolean);
    return {
      seller: seller.id,
      productId: String(p.id),
      handle: p.slug,
      url: p.permalink,
      title: p.name,
      ...(present(brand) ? { brand } : {}),
      ...(p.categories?.[0]?.name ? { category: p.categories[0].name } : {}),
      ...(tags.length ? { tags } : {}),
      ...(present(p.sku) ? { sku: p.sku } : {}),
      ...(present(model) ? { model } : {}),
      ...(price ? { price } : {}),
      currency: p.prices?.currency_code ?? seller.currency,
      ...(p.is_in_stock === undefined ? {} : { available: p.is_in_stock }),
      checkedAt,
      extractor: "woocommerce-feed",
    };
  });
}

/** "19610" with two minor units is "196.10". No floating point on money. */
export function minorToDecimal(minor: string, units: number): string {
  if (units === 0) return minor;
  const padded = minor.padStart(units + 1, "0");
  return `${padded.slice(0, -units)}.${padded.slice(-units)}`;
}

function present(s: string | null | undefined): s is string {
  return typeof s === "string" && s.trim() !== "";
}

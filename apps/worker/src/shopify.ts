import type { Seller, Sighting } from "@origin89/equipment-schema/sighting";

/** The subset of a Shopify `products.json` product the spider reads. Everything else, `body_html` included, is left on the wire. */
export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  tags?: string[] | string;
  updated_at?: string;
  variants?: { title?: string; sku?: string | null; price?: string; available?: boolean }[];
}

/** Shopify pages at most 250 products per request; a page with fewer than that is the last one. */
export const SHOPIFY_PAGE_SIZE = 250;

export function shopifyPageUrl(seller: Seller, page: number): string {
  return `${seller.url.replace(/\/$/, "")}/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${page}`;
}

/**
 * One sighting per variant, since a variant is what carries the SKU and the price. A product with
 * a single "Default Title" variant yields one sighting with no variant label.
 */
export function sightingsFromShopify(
  seller: Seller,
  products: ShopifyProduct[],
  checkedAt: string,
): Sighting[] {
  const out: Sighting[] = [];
  for (const p of products) {
    const base = {
      seller: seller.id,
      productId: String(p.id),
      handle: p.handle,
      url: `${seller.url.replace(/\/$/, "")}/products/${p.handle}`,
      title: p.title,
      ...(present(p.vendor) ? { brand: p.vendor } : {}),
      ...(present(p.product_type) ? { category: p.product_type } : {}),
      ...tagsOf(p.tags),
      currency: seller.currency,
      ...(p.updated_at ? { updatedAt: p.updated_at } : {}),
      checkedAt,
      extractor: "shopify-feed" as const,
    };
    const variants = p.variants?.length ? p.variants : [{}];
    for (const v of variants) {
      const variant = v.title && v.title !== "Default Title" ? v.title : undefined;
      out.push({
        ...base,
        ...(present(v.sku) ? { sku: v.sku } : {}),
        ...(variant ? { variant } : {}),
        ...(v.price ? { price: v.price } : {}),
        ...(v.available === undefined ? {} : { available: v.available }),
      });
    }
  }
  return out;
}

function present(s: string | null | undefined): s is string {
  return typeof s === "string" && s.trim() !== "";
}

function tagsOf(tags: ShopifyProduct["tags"]): { tags?: string[] } {
  if (Array.isArray(tags)) return tags.length ? { tags } : {};
  if (present(tags))
    return {
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
  return {};
}

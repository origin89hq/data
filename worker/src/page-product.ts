import type { Seller, Sighting } from "../../schema/sighting.ts";

/**
 * What a product page states about itself, before it becomes a sighting. Read from the page's
 * own structured data: schema.org JSON-LD where the platform emits it, microdata where it does
 * not. Nothing here is inferred from prose — a page that says nothing yields nothing.
 */
export interface PageProduct {
  name?: string;
  brand?: string;
  /** The maker, when the page names one separately from the brand. */
  manufacturer?: string;
  sku?: string;
  /** Manufacturer part number, which is a model number far more often than a SKU is. */
  mpn?: string;
  price?: string;
  currency?: string;
  availability?: boolean;
  category?: string;
}

const LD_BLOCK = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Walk a JSON-LD graph for the first Product node, since pages nest them under @graph or arrays. */
function findProduct(node: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6 || node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProduct(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => t === "Product" || t === "ProductGroup")) return record;
  for (const key of ["@graph", "mainEntity", "itemListElement"]) {
    const found = findProduct(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

const named = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const name = (v as { name?: unknown }).name;
    if (typeof name === "string") return name.trim() || undefined;
  }
  return undefined;
};

const text = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() || undefined : typeof v === "number" ? String(v) : undefined);

/** A price is kept as the page printed it, normalised only to a plain decimal. Money never becomes a float. */
export function normalisePrice(v: unknown): string | undefined {
  const raw = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : undefined;
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d.,]/g, "");
  const match = /^(\d{1,3}(?:,\d{3})*|\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return undefined;
  const whole = match[1].replace(/,/g, "");
  return match[2] ? `${whole}.${match[2]}` : whole;
}

function offerOf(product: Record<string, unknown>): { price?: string; currency?: string; availability?: boolean } {
  const offers = product.offers;
  const first = Array.isArray(offers) ? offers[0] : offers;
  if (!first || typeof first !== "object") return {};
  const o = first as Record<string, unknown>;
  const availability = typeof o.availability === "string" ? /InStock|LimitedAvailability|PreOrder/i.test(o.availability) : undefined;
  return {
    price: normalisePrice(o.price ?? (o.priceSpecification as { price?: unknown })?.price),
    currency: text(o.priceCurrency),
    availability,
  };
}

/** Read the page's JSON-LD. Returns nothing when there is no Product node, which is a fact, not a failure. */
export function fromJsonLd(html: string): PageProduct | undefined {
  for (const match of html.matchAll(LD_BLOCK)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const product = findProduct(parsed);
    if (!product) continue;
    const offer = offerOf(product);
    return {
      name: text(product.name),
      brand: named(product.brand),
      manufacturer: named(product.manufacturer),
      sku: text(product.sku),
      mpn: text(product.mpn),
      category: named(product.category),
      ...offer,
    };
  }
  return undefined;
}

/** Elements that never have a closing tag, so they never open a nested scope to walk out of. */
const VOID_TAGS = new Set(["meta", "link", "img", "br", "hr", "input", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);

/**
 * The inner markup of the element that starts at `open`, found by counting its own tag in and
 * out. A regex cannot do this: the breadcrumb list on a BigCommerce page is a div inside the
 * product's div, and stopping at the first `</div>` would cut the product in half.
 */
export function elementInner(html: string, openIndex: number, openTag: string, tagName: string): string | undefined {
  const tag = tagName.toLowerCase();
  if (VOID_TAGS.has(tag) || /\/\s*>$/.test(openTag)) return "";
  const from = openIndex + openTag.length;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    if (/\/\s*>$/.test(m[0])) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return undefined;
}

const OPEN_TAG = /<(\w+)([^>]*)>/g;
const attr = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];
const plain = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * Read schema.org microdata, which is what BigCommerce emits instead of JSON-LD. A property
 * belongs to its nearest enclosing scope, so a nested scope is skipped whole: the breadcrumb
 * trail inside the product element names "Home", and that is not the product's name.
 */
export function fromMicrodata(html: string): PageProduct | undefined {
  const open = /<(\w+)([^>]*\bitemtype\s*=\s*["'][^"']*schema\.org\/Product["'][^>]*)>/i.exec(html);
  if (!open) return undefined;
  const scope = elementInner(html, open.index, open[0], open[1]);
  if (scope === undefined) return undefined;

  const props = new Map<string, string>();
  const set = (name: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !props.has(name)) props.set(name, trimmed);
  };

  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(scope); m; m = OPEN_TAG.exec(scope)) {
    const [tag, name, attrs] = [m[0], m[1], m[2]];
    const nested = /\bitemscope\b/i.test(attrs);
    const prop = attr(attrs, "itemprop");
    const inner = nested ? elementInner(scope, m.index, tag, name) : undefined;

    if (nested) {
      // A nested scope's own properties are its, not the product's. Only the value it stands
      // for — a Brand's name, an Offer's price — is read, then the whole block is stepped over.
      if (prop && inner !== undefined) {
        const innerName = /<\w+[^>]*\bitemprop\s*=\s*["']name["'][^>]*>([\s\S]*?)<\/\w+>/i.exec(inner);
        if (innerName) set(prop, plain(innerName[1]));
        else if (prop === "offers") {
          for (const key of ["price", "priceCurrency", "availability"]) {
            const meta = new RegExp(`<\\w+[^>]*\\bitemprop\\s*=\\s*["']${key}["']([^>]*)>`, "i").exec(inner);
            if (meta) set(key, attr(meta[1], "content") ?? attr(meta[1], "href"));
          }
        }
      }
      if (inner !== undefined) OPEN_TAG.lastIndex = m.index + tag.length + inner.length;
      continue;
    }

    if (!prop) continue;
    const content = attr(attrs, "content") ?? (prop === "availability" ? attr(attrs, "href") : undefined);
    if (content !== undefined) {
      set(prop, content);
      continue;
    }
    const body = elementInner(scope, m.index, tag, name);
    if (body) set(prop, plain(body));
  }
  if (props.size === 0) return undefined;

  const availability = props.get("availability");
  return {
    name: props.get("name"),
    brand: label(props.get("brand")),
    manufacturer: label(props.get("manufacturer")),
    sku: props.get("sku"),
    mpn: props.get("mpn"),
    price: normalisePrice(props.get("price")),
    currency: props.get("priceCurrency"),
    ...(availability === undefined ? {} : { availability: /InStock|LimitedAvailability|PreOrder/i.test(availability) }),
  };
}

/** Themes print the label with the value: "Brand : IntegraRack" is the brand IntegraRack. */
function label(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^\s*(brand|manufacturer|make|mfg)\s*[:\-]\s*/i, "").trim() || undefined;
}

/** JSON-LD first, microdata second: a page that publishes both means the same thing in each, and JSON-LD parses exactly. */
export function extractProduct(html: string): { product: PageProduct; extractor: "json-ld" } | { product: PageProduct; extractor: "micro-data" } | undefined {
  const ld = fromJsonLd(html);
  if (ld?.name) return { product: ld, extractor: "json-ld" };
  const micro = fromMicrodata(html);
  if (micro?.name) return { product: micro, extractor: "micro-data" };
  return undefined;
}

/**
 * A part number that is all digits and eight or more of them is a barcode, not a model: Shopify
 * stores put the GTIN in `mpn` routinely, and "990317712768" tells a reader nothing.
 */
export function modelOf(product: PageProduct): string | undefined {
  const mpn = product.mpn?.trim();
  if (!mpn || mpn === product.sku?.trim()) return undefined;
  if (/^\d{8,}$/.test(mpn)) return undefined;
  return mpn;
}

/**
 * A page product becomes a sighting only if the page named it. The product id is the page's own
 * path, because a page tier has no store id to use and a path is stable for as long as the URL is.
 */
export function sightingFromPage(seller: Seller, url: string, html: string, checkedAt: string): Sighting | undefined {
  const found = extractProduct(html);
  if (!found) return undefined;
  const { product, extractor } = found;
  const title = product.name;
  if (!title) return undefined;
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  const handle = path.split("/").filter(Boolean).pop() ?? path;
  if (!path) return undefined;
  return {
    seller: seller.id,
    productId: path,
    handle,
    url,
    title,
    ...(product.brand ? { brand: product.brand } : {}),
    ...(product.category ? { category: product.category } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    ...(modelOf(product) ? { model: modelOf(product) } : {}),
    ...(product.price ? { price: product.price } : {}),
    currency: product.currency ?? seller.currency,
    ...(product.availability === undefined ? {} : { available: product.availability }),
    checkedAt,
    extractor,
  };
}

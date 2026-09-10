/**
 * Where a maker's logo comes from, and how to read one off a page without pairing it with the
 * wrong brand.
 *
 * Two sources, in this order. A maker's own site is the first: its `apple-touch-icon` is the mark
 * the company chose, at the size it chose. A retailer's brand page is the second, and it reaches
 * makers the first cannot — Rolls Battery refuses our fetch and six shops carry its logo anyway.
 * A retailer's copy is one hop further from the company, so it never displaces the maker's own.
 */

/**
 * A tile on a shop's brand page: one link to a brand, one image inside it.
 *
 * Read from the anchor's own bounds, never from proximity. The first version of this walked the
 * document remembering the last link seen and attaching the next image to it, which put a
 * Cinderella incinerating toilet against The Cabin Depot's "camera-systems". Six shops use six
 * different class names for the tile — promotion__item, logolist--item, brand-card — so the
 * anchor is the only container all of them share.
 */
const ANCHOR = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{0,6000}?)<\/a>/gi;
const IMAGE = /<img\b[^>]*?\b(?:src|data-src)="([^"]+)"/i;

export interface BrandTile {
  /** The collection the tile links to, which is the shop's name for the brand. */
  slug: string;
  /** Absolute URL of the image inside that same anchor. */
  image: string;
}

/** Every brand tile on a shop's page, each image taken from inside its own link. */
export function brandTiles(html: string, pageUrl: string): BrandTile[] {
  const out: BrandTile[] = [];
  const seen = new Set<string>();
  for (const [, href, inner] of html.matchAll(ANCHOR)) {
    if (!href.includes("/collections/")) continue;
    const image = IMAGE.exec(inner)?.[1];
    if (!image) continue;
    // A link into a product inside a collection is not a brand tile.
    const slug = href.split("/collections/")[1]?.split("?")[0]?.replace(/\/$/, "");
    if (!slug || slug.includes("/") || seen.has(slug)) continue;
    seen.add(slug);
    try {
      // Shopify writes "&amp;" in the attribute and appends its own width; drop the query and ask
      // for the size we want later.
      out.push({ slug, image: new URL(image.split("&amp;")[0], pageUrl).href });
    } catch {
      continue;
    }
  }
  return out;
}

/** A shop's slug reduced to the brand it names: "victron-energy-products" is Victron Energy. */
export function brandOfSlug(slug: string): string {
  return slug.replace(/-(products?|collection|brand|shop)$/i, "");
}

/** The comparable form of a name, so "EG4 Electronics" and "eg4-electronics" are one string. */
export const nameKey = (name: string): string => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/**
 * Which manufacturer a tile names, or undefined when none does.
 *
 * Matched against names somebody confirmed, never guessed at. Simple Icons was tried first and its
 * near-matches gave a cryptocurrency's logo for IOTA Engineering's power converters and Acura's
 * for Honda Power Equipment, so a tile that answers to nothing here gets no logo at all.
 */
export function matchTile(tile: BrandTile, byName: Map<string, string>): string | undefined {
  return byName.get(nameKey(tile.slug)) ?? byName.get(nameKey(brandOfSlug(tile.slug)));
}

/** An icon a page declares, with the size it claims for it. */
export interface PageIcon {
  url: string;
  /** The declared width. An apple-touch-icon counts as 180 because that is what it is for. */
  size: number;
}

/**
 * The icons a maker's own page declares, largest first.
 *
 * The size matters for more than ordering. Five makers declare nothing but a `favicon.ico` of
 * about a kilobyte, which is a browser-tab glyph rather than a mark, and a shop's brand page
 * carries a proper wordmark for the same company. Anything below [`GOOD_ICON`] loses to that.
 */
export function iconsInPage(html: string, pageUrl: string): PageIcon[] {
  const out: PageIcon[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel="[^"]*icon[^"]*"/i.test(tag)) continue;
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    if (!href) continue;
    const sizes = /\bsizes="(\d+)x\d+"/i.exec(tag)?.[1];
    // An apple-touch-icon is the mark a company chose for a home screen, so it is a logo rather
    // than the 16-pixel favicon beside it, and it is worth more than its declared size suggests.
    const declared = sizes ? Number(sizes) : /apple-touch/i.test(tag) ? 180 : 32;
    try {
      out.push({ url: new URL(href, pageUrl).href, size: declared });
    } catch {
      continue;
    }
  }
  return [...new Map(out.sort((a, b) => b.size - a.size).map((i) => [i.url, i])).values()];
}

/** Below this a maker's own icon is a tab glyph, and a shop's wordmark is the better logo. */
export const GOOD_ICON = 64;

/** The widths published for every logo, so a page can ask for the one it needs. */
export const LOGO_WIDTHS = [64, 128, 256] as const;

/** Where a logo of this maker at this width lives in the archive. */
export const logoKey = (manufacturer: string, width: number): string => `logos/${manufacturer}-${width}.png`;

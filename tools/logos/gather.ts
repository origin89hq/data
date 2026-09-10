import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { Manufacturer } from "../../schema/manufacturer.ts";
import { brandTiles, GOOD_ICON, iconsInPage, LOGO_WIDTHS, logoKey, matchTile, nameKey } from "../../src/logos.ts";
import { USER_AGENT } from "../../scraper/src/feeds.ts";

/**
 * Find a logo for every manufacturer and write it to disk at the published widths.
 *
 * Two sources, and the order matters. A maker's own site is asked first, because its icon is the
 * mark the company chose. A shop's brand page is asked second, and it reaches makers the first
 * cannot: Rolls Battery refuses our fetch and six shops carry its logo anyway. A shop's copy never
 * displaces the maker's own.
 *
 * Nothing is matched by resemblance. A tile is adopted only when its slug answers to a
 * manufacturer somebody confirmed, because the first attempt at this used a general icon set and
 * its near-matches offered a cryptocurrency's logo for IOTA Engineering's power converters.
 *
 * Usage: gather.ts [--out <dir>] [--only <manufacturer>] [--sellers-only] [--makers-only]
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback);
const outDir = flag("--out", "dist/logos");
const only = args.includes("--only") ? flag("--only", "") : undefined;
const today = new Date().toISOString().slice(0, 10);

/** Shops that publish a page of brand logos, and where it is. */
const BRAND_PAGES = [
  { seller: "thecabindepot", url: "https://thecabindepot.ca/pages/shop-by-brand" },
  { seller: "offgridstores", url: "https://offgridstores.com/pages/brands" },
  { seller: "shopsolarkits", url: "https://shopsolarkits.com/pages/brands" },
  { seller: "solarpowerstore", url: "https://solarpowerstore.ca/pages/shop-by-brand" },
  { seller: "offgridsource", url: "https://offgridsource.com/pages/brands" },
  { seller: "thesolarstore", url: "https://thesolarstore.com/pages/brands" },
];

/** Below the smallest width we publish, a source is a tab glyph and there is nothing to publish. */
const MIN_SOURCE = LOGO_WIDTHS[0];

/**
 * Whether these bytes are a logo rather than something else that was in the tile.
 *
 * Three things got through the first run. ECO-WORTHY's tile on one shop is a 5400x1500 promotional
 * banner, so anything far from square is refused. Lorex declares a favicon its own URL asks to be
 * served at 32 pixels, which upscales to a smear, so a source smaller than the largest width we
 * publish is refused. And Precision Circuits' mark is white on transparent, which is a real logo
 * and an invisible one on a white page, so an image that vanishes when flattened is refused too.
 */
const usable = async (bytes: Buffer): Promise<string | undefined> => {
  const image = sharp(bytes);
  const { width, height } = await image.metadata();
  if (!width || !height) return "no dimensions";
  const ratio = width / height;
  if (ratio > 2.6 || ratio < 1 / 2.6) return `${width}x${height} is a banner, not a mark`;
  // Lorex's own URL asks to be served at 32 pixels, which upscales to a smear. Above this floor a
  // source is published only at the widths it can carry, rather than blown up to all of them.
  if (Math.max(width, height) < MIN_SOURCE) return `only ${width}x${height}, below the smallest width we publish`;
  // How much of the image is still visible once it sits on a white page. The first version of this
  // asked sharp for statistics after flattening, which does not work — `stats()` reads the input
  // rather than the pipeline, so it reported plenty of contrast for Anker's reverse logo and that
  // published a blank square. Counting the pixels is the measurement that matches what a reader sees.
  const flat = await sharp(bytes).flatten({ background: "#ffffff" }).greyscale().raw().toBuffer();
  const ink = flat.reduce((n, value) => n + (value < 224 ? 1 : 0), 0) / flat.length;
  if (ink < 0.015) return `${(ink * 100).toFixed(1)}% ink on white, so it would publish blank`;
  return undefined;
};

/** Shopify and WordPress append the size they served; ask for the original instead. */
const original = (url: string): string => {
  try {
    const u = new URL(url);
    for (const p of ["width", "height", "w", "h", "fit", "resize", "crop"]) u.searchParams.delete(p);
    return u.href;
  } catch {
    return url;
  }
};

const get = async (url: string): Promise<Response | undefined> => {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
    return res.ok ? res : undefined;
  } catch {
    return undefined;
  }
};

const records = loadRecords();
const makers = records.manufacturers.filter((m) => !only || m.id === only);

// Every string a manufacturer answers to, including the brands sellers print for it.
const byName = new Map<string, string>();
for (const m of records.manufacturers) {
  for (const name of [m.name, m.name.replace(/\s*\(.*\)\s*$/, ""), m.id]) byName.set(nameKey(name), m.id);
}
for (const brand of records.brands ?? []) {
  const id = (brand as { manufacturer?: string }).manufacturer;
  const name = (brand as { name?: string }).name;
  if (id && name && records.manufacturers.some((m) => m.id === id)) byName.set(nameKey(name), id);
}

interface Candidate {
  source: string;
  from: string;
  /** Higher is tried first. A maker's own mark beats a shop's copy; a tab glyph beats nothing. */
  rank: number;
}
/** Every candidate for each maker, best first, so a source that cannot be read falls through. */
const found = new Map<string, Candidate[]>();
const offer = (id: string, candidate: Candidate) => {
  const list = [...(found.get(id) ?? []), candidate].sort((a, b) => b.rank - a.rank);
  found.set(id, list);
};

// The shops first, so the maker's own icon can overwrite a shop's copy rather than the other way.
if (!args.includes("--makers-only")) {
  for (const page of BRAND_PAGES) {
    const res = await get(page.url);
    if (!res) {
      console.log(`${page.seller}: brand page did not answer`);
      continue;
    }
    const tiles = brandTiles(await res.text(), res.url);
    let matched = 0;
    for (const tile of tiles) {
      const id = matchTile(tile, byName);
      if (!id || (only && id !== only)) continue;
      // A shop's brand page carries a proper wordmark, so it beats a maker's bare favicon.
      offer(id, { source: tile.image, from: `seller:${page.seller}`, rank: 2 });
      matched += 1;
    }
    console.log(`${page.seller}: ${tiles.length} tiles, ${matched} new manufacturers`);
  }
}

if (!args.includes("--sellers-only")) {
  let fromMakers = 0;
  await Promise.all(
    makers.map(async (m) => {
      if (!m.website) return;
      const res = await get(m.website);
      if (!res) return;
      const icons = iconsInPage(await res.text(), res.url);
      if (icons.length === 0) return;
      for (const icon of icons) {
        // An .ico is a browser-tab glyph and cannot even be decoded here; it is a last resort.
        const ico = /\.ico(\?|$)/i.test(icon.url);
        offer(m.id, { source: icon.url, from: "maker", rank: ico ? 1 : icon.size >= GOOD_ICON ? 3 : 1.5 });
      }
      fromMakers += 1;
    }),
  );
  console.log(`makers' own sites: ${fromMakers} icons`);
}

mkdirSync(outDir, { recursive: true });
let written = 0;
const failed: string[] = [];
const taken = new Map<string, string>();
for (const [id, candidates] of [...found].sort()) {
  let done = false;
  const why: string[] = [];
  for (const candidate of candidates) {
    const source = original(candidate.source);
    const res = await get(source);
    if (!res) {
      why.push(`${candidate.from} did not answer`);
      continue;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // A page served where an image was asked for is a redirect to a holding page, not a logo.
    if (!/^(image|application\/octet-stream)/.test(res.headers.get("content-type") ?? "")) {
      why.push(`${candidate.from} served ${res.headers.get("content-type") ?? "nothing"}`);
      continue;
    }
    const unusable = await usable(bytes).catch((e) => String(e).replace(/^Error: /, "").slice(0, 44));
    if (unusable) {
      why.push(`${candidate.from} ${unusable}`);
      continue;
    }
    // Only the widths this source can carry. An apple-touch-icon is 180, so it gives 64 and 128
    // and not 256: a soft logo looks worse on a page than a smaller sharp one.
    const shape = await sharp(bytes).metadata();
    const largest = Math.max(shape.width ?? 0, shape.height ?? 0);
    const widths: number[] = [];
    try {
      for (const width of LOGO_WIDTHS.filter((w) => w <= largest)) {
        // Fitted inside the box rather than cropped: a wordmark is wider than it is tall and
        // cropping it to a square cuts the name in half.
        const png = await sharp(bytes).resize({ width, height: width, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        writeFileSync(join(outDir, `${id}-${width}.png`), png);
        widths.push(width);
      }
    } catch (error) {
      why.push(`${candidate.from} ${String(error).replace(/^Error: /, "").slice(0, 44)}`);
      continue;
    }
    const maker = records.manufacturers.find((m) => m.id === id);
    if (!maker) break;
    writeRecord(
      RECORDS_DIR,
      "manufacturers",
      id,
      Manufacturer.parse({
        ...maker,
        logo: { source, from: candidate.from, sha256: createHash("sha256").update(bytes).digest("hex"), widths, checkedAt: today },
      }),
    );
    taken.set(id, candidate.from);
    written += 1;
    done = true;
    break;
  }
  if (!done) failed.push(`${id}: ${why.join("; ") || "no candidate"}`);
}

// A record that claims a logo we can no longer produce is pointing at nothing. This run tightened
// what counts as a mark, and seven records were left naming a file the archive would not have.
let cleared = 0;
for (const maker of records.manufacturers) {
  if (!maker.logo || taken.has(maker.id) || (only && maker.id !== only)) continue;
  const { logo, ...rest } = maker;
  writeRecord(RECORDS_DIR, "manufacturers", maker.id, Manufacturer.parse(rest));
  cleared += 1;
}
if (cleared) console.log(`${cleared} records no longer claim a logo this run could not produce`);

console.log(`\n${written} manufacturers have a logo, written to ${outDir} at ${LOGO_WIDTHS.join(", ")} px`);
console.log(`  ${[...taken.values()].filter((f) => f === "maker").length} from the maker's own site, ${[...taken.values()].filter((f) => f.startsWith("seller:")).length} from a shop's brand page`);
if (failed.length) {
  console.log(`\n${failed.length} could not be fetched or read:`);
  for (const line of failed.slice(0, 15)) console.log(`  ${line}`);
}
console.log(`\nupload with: just logos-upload`);
console.log(`archive keys look like ${logoKey("victron-energy", LOGO_WIDTHS[1])}`);

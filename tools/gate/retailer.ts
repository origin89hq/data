import type { Brand } from "@origin89/equipment-schema/brand";
import type { Manufacturer } from "@origin89/equipment-schema/manufacturer";
import { VISION_EXTRACTOR_ID } from "@origin89/equipment-schema/provenance";
import { CONVERTER, PAGE_CONVERTER } from "../../apps/worker/src/reading.ts";
import { TABLE_READER } from "../../apps/worker/src/spec-table.ts";

/**
 * A retailer's own label is held as a maker, and its site hosts its suppliers' documents beside
 * its own. The Cabin Depot's run held 40 documents, nearly all other makers': BLUETTI's EPANEL
 * manual, Unique's range sheets, J.A. Roby's stove manual, Kinetic Solar's CSA certificate. The
 * pull wrote every product in them under the shop, 185 figures in all (#30). So a retailer is
 * credited with a document only when the document names it.
 */

/**
 * The names a retailer answers to in a document: its own name without the note in brackets, and
 * every brand string resolved to it. "The Cabin Depot (retailer house brands)" is "The Cabin
 * Depot", and Kedron is its label.
 */
export function retailerNames(maker: Manufacturer, brands: readonly Brand[]): string[] {
  const own = maker.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const labels = brands.filter((b) => b.manufacturer === maker.id).map((b) => b.brand.trim());
  return [...new Set([own, ...labels].filter(Boolean))];
}

/** Whether a text names one of these, as a whole name, in any case, across any spacing. */
export function namesAny(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const pattern = name
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(text);
  });
}

/**
 * Where the text a reading was taken from is kept: the page itself for the table parser, the
 * page transcript for the page reader, and the conversion for the text reader.
 */
export function textKey(reading: { sha256: string; extractedBy?: string }): string {
  if (reading.extractedBy === TABLE_READER) return `archive/${reading.sha256}`;
  if (reading.extractedBy === VISION_EXTRACTOR_ID)
    return `archive/${reading.sha256}.${PAGE_CONVERTER}.md`;
  return `archive/${reading.sha256}.${CONVERTER}.md`;
}

/** A document withheld from a retailer, for a person to look at. */
export interface Withheld {
  url: string;
  sha256: string;
  products: number;
  reason: string;
}

/**
 * The readings a maker is credited with. Every one for a maker, and for a retailer only those
 * whose documents name it; any other maker's readings are untouched and no text is fetched.
 */
export async function creditedReadings<
  R extends { sha256: string; url: string; products: unknown[] },
>(
  maker: Manufacturer | undefined,
  brands: readonly Brand[],
  readings: readonly R[],
  textOf: (reading: R) => Promise<string | undefined>,
): Promise<{ keep: R[]; withheld: Withheld[] }> {
  if (!maker?.retailer) return { keep: [...readings], withheld: [] };
  return namedReadings(readings, retailerNames(maker, brands), textOf);
}

/**
 * A retailer's readings, kept only when the document they read names the retailer. One that does
 * not is withheld rather than written, and so is one whose text cannot be read to check: for a
 * retailer, not knowing is not a reason to credit it. A reading with no products credits nothing
 * either way, so its text is not fetched.
 */
export async function namedReadings<R extends { sha256: string; url: string; products: unknown[] }>(
  readings: readonly R[],
  names: readonly string[],
  textOf: (reading: R) => Promise<string | undefined>,
): Promise<{ keep: R[]; withheld: Withheld[] }> {
  const keep: R[] = [];
  const withheld: Withheld[] = [];
  for (const reading of readings) {
    if (reading.products.length === 0) {
      keep.push(reading);
      continue;
    }
    const text = await textOf(reading);
    if (text !== undefined && namesAny(text, names)) {
      keep.push(reading);
      continue;
    }
    withheld.push({
      url: reading.url,
      sha256: reading.sha256,
      products: reading.products.length,
      reason:
        text === undefined
          ? "its text is not in the archive"
          : `it names none of ${names.join(", ")}`,
    });
  }
  return { keep, withheld };
}

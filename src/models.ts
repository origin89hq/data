import type { Brand } from "../schema/brand.ts";
import type { Dialect } from "../schema/dialect.ts";
import type { Guess } from "../schema/guess.ts";
import type { Model } from "../schema/model.ts";
import type { Sighting } from "../schema/sighting.ts";
import type { EquipmentKind } from "../schema/guess.ts";
import { brandId } from "./gate.ts";

/**
 * Tidy a model string without changing what it says. Sellers paste from spreadsheets, so a name
 * arrives with smart quotes and a trailing comma still attached — `CC-USB-RS485-150U”,` is one
 * that reached this repo — and those are transcription damage, not part of the name.
 */
export function normaliseModelName(raw: string): string {
  return raw
    .replace(/[‘’“”]/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[\s"',;:.\-–—]+$/g, "")
    .replace(/^[\s"',;:]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that mean the string is a description of a product, not the name of one. */
const PROSE = /\b(pallet|bundle|kit for|pack of|set of|includes|with built|scratch|refurb|open box|per foot|sold per)\b/i;

/** A count with a unit is what a shop puts in a title: "25 lbs", "4 pack". No maker names a product that. */
const QUANTITY = /\b\d+(\.\d+)?\s*(lbs?|kg|oz|pack|pcs?|ft|feet|foot|in|inch|inches|gal|litres?|liters?|ml)\b/i;

/**
 * A measurement, which names a rating rather than a product. The unit is required: "100W" is a
 * rating, but "2719" is a Blue Sea catalogue number and "31110.000" is a Wöhner one, and a rule
 * that rejected bare digits would throw both away.
 */
const MEASUREMENT = /^\$?\d+(\.\d+)?\s*(w|watt|watts|v|volt|volts|ah|a|amp|amps|kw|kwh|mm|cm|wh)$/i;

/** A token that could not be an English word: a part number, an acronym, a code. */
function codeLike(token: string): boolean {
  if (/[A-Za-z]/.test(token) && /\d/.test(token)) return true;
  if (/[A-Z]{2,}/.test(token)) return true;
  return false;
}

/**
 * Whether a string is plausibly a model name rather than a sentence. A seller's model field is
 * often the title again, so this is the difference between a models table and a copy of the shop.
 *
 * It is deliberately strict: a name wrongly rejected is a missing row somebody can add, while a
 * sentence wrongly accepted is a model that does not exist and that a later reader has to
 * disprove. "Estate Lawn Seed 25 lbs" reached this repo as a model number, which is the case it
 * is written against.
 */
export function looksLikeModelName(name: string): boolean {
  if (name.length < 2 || name.length > 48) return false;
  if (PROSE.test(name) || QUANTITY.test(name) || MEASUREMENT.test(name)) return false;
  const words = name.split(" ");
  if (words.length > 5) return false;
  // A single token only has to look like a code; Blue Sea's 2719 and Wöhner's 31110.000 are real
  // names with no letters in them at all.
  if (words.length === 1) return /\d/.test(name) || /[A-Z]{2,}/.test(name);
  return words.some(codeLike);
}

/** A model id has to be unique per maker and stable, so it carries the maker and a slug of the name. */
export function modelId(manufacturer: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${manufacturer}-${slug}`.slice(0, 120).replace(/-+$/, "");
}

export interface DerivedModel {
  model: Model;
  /** How many listings named it, which is how a real product is told from a typo. */
  listings: number;
  sellers: string[];
}

export interface DeriveInput {
  sightings: Sighting[];
  guesses: Map<string, Guess>;
  brands: Brand[];
  dialects: Dialect[];
}

/**
 * Turn crawled listings into model candidates. A listing contributes only when its brand string
 * resolves to a manufacturer, because a model with no owner is a string; and only when nothing
 * has classified it as out of scope, because a cast-iron skillet has a SKU too.
 *
 * Nothing here is reviewed. A derived model carries no reviewer and no basis, and the validator
 * counts it as unconfirmed until somebody checks it against the maker's own document.
 */
export function deriveModels({ sightings, guesses, brands, dialects }: DeriveInput): DerivedModel[] {
  const makerOf = new Map(brands.filter((b) => b.decision === "manufacturer").map((b) => [b.id, b.manufacturer!]));
  const dialectByModel = new Map<string, string[]>();
  for (const d of dialects) {
    for (const m of d.models ?? []) {
      const key = normaliseModelName(m.name).toLowerCase();
      if (!key) continue;
      dialectByModel.set(key, [...(dialectByModel.get(key) ?? []), d.id]);
    }
  }

  const rows = new Map<string, { model: Model; listings: number; sellers: Set<string>; kinds: Map<EquipmentKind, number> }>();
  for (const s of sightings) {
    const maker = s.brand ? makerOf.get(brandId(s.brand)) : undefined;
    if (!maker) continue;
    const guess = guesses.get(`${s.seller}/${s.productId}`);
    if (guess?.kind === "out-of-scope") continue;
    for (const candidate of [s.model, s.sku]) {
      if (!candidate) continue;
      const name = normaliseModelName(candidate);
      if (!looksLikeModelName(name)) continue;
      const id = modelId(maker, name);
      const row = rows.get(id) ?? {
        model: { id, manufacturer: maker, name, ...(guess ? { kind: guess.kind } : {}), aliases: [], dialects: dialectByModel.get(name.toLowerCase()) ?? [] } as Model,
        listings: 0,
        sellers: new Set<string>(),
        kinds: new Map<EquipmentKind, number>(),
      };
      row.listings += 1;
      row.sellers.add(s.seller);
      if (guess) row.kinds.set(guess.kind, (row.kinds.get(guess.kind) ?? 0) + 1);
      if (s.model && s.sku && normaliseModelName(s.sku) !== name && looksLikeModelName(normaliseModelName(s.sku))) {
        const alias = normaliseModelName(s.sku);
        if (!row.model.aliases.includes(alias)) row.model.aliases.push(alias);
      }
      rows.set(id, row);
      break; // The maker's model field wins over the seller's SKU; only one of the two names the product.
    }
  }

  return [...rows.values()]
    .map((r) => {
      // The kind most classifiers agreed on, so one odd answer does not decide it. With no
      // classifier at all the kind stays absent rather than taking a default.
      const kind = [...r.kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return { model: { ...r.model, ...(kind ? { kind } : {}), aliases: r.model.aliases.sort(), dialects: r.model.dialects.sort() }, listings: r.listings, sellers: [...r.sellers].sort() };
    })
    .sort((a, b) => a.model.id.localeCompare(b.model.id));
}

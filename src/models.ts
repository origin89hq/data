import type { Brand } from "@origin89/equipment-schema/brand";
import type { Dialect } from "@origin89/equipment-schema/dialect";
import type { EquipmentKind, Guess } from "@origin89/equipment-schema/guess";
import type { Model } from "@origin89/equipment-schema/model";
import type { Sighting } from "@origin89/equipment-schema/sighting";
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
const PROSE =
  /\b(pallet|bundle|kit for|pack of|set of|includes|with built|scratch|refurb|open box|per foot|sold per)\b/i;

/** A count with a unit is what a shop puts in a title: "25 lbs", "4 pack". No maker names a product that. */
const QUANTITY =
  /\b\d+(\.\d+)?\s*(lbs?|kg|oz|pack|pcs?|ft|feet|foot|in|inch|inches|gal|litres?|liters?|ml)\b/i;

/**
 * A measurement, which names a rating rather than a product. The unit is required: "100W" is a
 * rating, but "2719" is a Blue Sea catalogue number and "31110.000" is a Wöhner one, and a rule
 * that rejected bare digits would throw both away.
 */
const MEASUREMENT =
  /^\$?\d+(\.\d+)?\s*(w|watt|watts|v|volt|volts|ah|a|amp|amps|kw|kwh|mm|cm|wh|%|°|°c|°f)$/i;

/**
 * A name that is nothing but measurements, including a parenthesised conversion. Rolls publishes a
 * capacity-against-temperature chart whose columns are "40°C (104°F)" and whose row is "102%", and
 * every one of them passed as a model until the entities in them were decoded and read properly.
 */
function allMeasurement(name: string): boolean {
  const parts = name
    .split(/[()]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => MEASUREMENT.test(part));
}

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
  if (PROSE.test(name) || QUANTITY.test(name) || MEASUREMENT.test(name) || allMeasurement(name))
    return false;
  const words = name.split(" ");
  if (words.length > 5) return false;
  // A single token only has to look like a code; Blue Sea's 2719 and Wöhner's 31110.000 are real
  // names with no letters in them at all.
  if (words.length === 1) return /\d/.test(name) || /[A-Z]{2,}/.test(name);
  return words.some(codeLike);
}

/**
 * Words a name can lead with that belong to no maker: what a thing is, or a technology, which
 * several makers put in front of a part number. "MPPT 150/45" is Victron's and "MPPT 60-150" is
 * Xantrex's, and neither word makes the other's product theirs.
 */
const GENERIC = new Set([
  "inverter",
  "charger",
  "controller",
  "battery",
  "batteries",
  "panel",
  "module",
  "kit",
  "bundle",
  "system",
  "solar",
  "hybrid",
  "mppt",
  "pwm",
  "series",
  "model",
  "type",
  "lithium",
  "lifepo4",
  "agm",
  "gel",
  "flooded",
]);

/**
 * The family a model's name leads with: "MultiPlus-II" in "MultiPlus-II 48/3000/35-50",
 * "SmartSolar" in "SmartSolar MPPT 100/20". Nothing for a name that leads with a number or a
 * rating ("12V LiFePO4 Battery" is every battery maker's), a two-letter code, or a word that is
 * not a family, since those are shared by everybody.
 */
export function familyOf(name: string): string | undefined {
  const [lead] = normaliseModelName(name)
    .toLowerCase()
    .split(/[\s/]+/);
  if (!lead || lead.length < 3 || !/^[a-z]/.test(lead) || GENERIC.has(lead)) return undefined;
  return lead;
}

/**
 * The maker whose product a document's name belongs to, when it is not the document's maker.
 *
 * A maker's installation guide lists the inverters its battery works with, and the reader names
 * each row as a product. Rolls' S48-100LFP guide named seven MultiPlus-II variants that way, and
 * the pull minted every one under Rolls with the battery's current limits as their figures (#86).
 * A word that leads the names of at least two of one other maker's models, and none of this
 * maker's own, is that maker's family; a name carrying it anywhere is theirs. A word two other
 * makers both lead with is nobody's, and a name that leads with a number claims no family.
 */
export function familyOfAnotherMaker(
  models: readonly Model[],
  manufacturer: string,
  name: string,
): { family: string; manufacturer: string } | undefined {
  const makersByFamily = new Map<string, Map<string, number>>();
  for (const model of models) {
    const family = familyOf(model.name);
    if (!family) continue;
    const makers = makersByFamily.get(family) ?? new Map<string, number>();
    makers.set(model.manufacturer, (makers.get(model.manufacturer) ?? 0) + 1);
    makersByFamily.set(family, makers);
  }
  for (const token of normaliseModelName(name)
    .toLowerCase()
    .split(/[\s/]+/)) {
    const family = familyOf(token);
    const makers = family ? makersByFamily.get(family) : undefined;
    if (!family || !makers || makers.has(manufacturer)) continue;
    const others = [...makers].filter(([, count]) => count >= 2).map(([maker]) => maker);
    const [owner] = others;
    if (owner && others.length === 1) return { family, manufacturer: owner };
  }
  return undefined;
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
export function deriveModels({
  sightings,
  guesses,
  brands,
  dialects,
}: DeriveInput): DerivedModel[] {
  const makerOf = new Map(
    brands.flatMap((b) =>
      b.decision === "manufacturer" && b.manufacturer ? [[b.id, b.manufacturer] as const] : [],
    ),
  );
  const dialectByModel = new Map<string, string[]>();
  for (const d of dialects) {
    for (const m of d.models ?? []) {
      const key = normaliseModelName(m.name).toLowerCase();
      if (!key) continue;
      dialectByModel.set(key, [...(dialectByModel.get(key) ?? []), d.id]);
    }
  }

  const rows = new Map<
    string,
    { model: Model; listings: number; sellers: Set<string>; kinds: Map<EquipmentKind, number> }
  >();
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
        model: {
          id,
          manufacturer: maker,
          name,
          ...(guess ? { kind: guess.kind } : {}),
          aliases: [],
          dialects: dialectByModel.get(name.toLowerCase()) ?? [],
        } as Model,
        listings: 0,
        sellers: new Set<string>(),
        kinds: new Map<EquipmentKind, number>(),
      };
      row.listings += 1;
      row.sellers.add(s.seller);
      if (guess) row.kinds.set(guess.kind, (row.kinds.get(guess.kind) ?? 0) + 1);
      if (
        s.model &&
        s.sku &&
        normaliseModelName(s.sku) !== name &&
        looksLikeModelName(normaliseModelName(s.sku))
      ) {
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
      return {
        model: {
          ...r.model,
          ...(kind ? { kind } : {}),
          aliases: r.model.aliases.sort(),
          dialects: r.model.dialects.sort(),
        },
        listings: r.listings,
        sellers: [...r.sellers].sort(),
      };
    })
    .sort((a, b) => a.model.id.localeCompare(b.model.id));
}

/**
 * Words a seller appends to say what a thing is. They belong to the listing, not to the name a
 * maker put on the case: "OBX-IC2024S-120/60 Inverter/Charger", "OBX-IC2024S-120/60 Inverter" and
 * "OBX-IC2024S-120/60" are one product filed three times.
 */
const DESCRIPTOR =
  /\b(inverter|charger|controller|battery|batteries|panel|module|kit|bundle|system|solar|hybrid|all[\s-]?in[\s-]?one)\b/gi;

/**
 * The form of a model name that decides whether two records are the same product.
 *
 * Three things vary between a maker's datasheet and a shop's title and mean nothing: the maker's
 * own name on the front, a descriptor on the end, and where the spaces and hyphens fall. Fronius
 * writes a part number as "4,210,052,841" in one place and "4210052841" in another. So the key
 * drops all three, and what is left is the part number itself.
 *
 * It is deliberately not the stored name. A name is what the maker wrote; this is only the
 * question "are these the same thing".
 */
export function productKey(makerName: string, name: string): string {
  let text = ` ${normaliseModelName(name).toLowerCase()} `;
  // The maker's own name, whole words only, so "EG4 6000XP" and "6000XP" meet but "Solark" inside
  // a part number survives.
  for (const word of makerName
    .replace(/\s*\(.*\)\s*$/, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (word.length > 2) text = text.replaceAll(word, " ");
  }
  return text.replace(DESCRIPTOR, " ").replace(/[^a-z0-9]/g, "");
}

/**
 * Which of two names for one product to keep: the maker's own, which is the shorter once the
 * seller's additions are gone. "6000XP" over "PVEG4 6000XP Inverter", and the other becomes an
 * alias rather than a record.
 */
export function preferredName(names: readonly string[]): string {
  return [...names].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? "";
}

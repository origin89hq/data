import type { Model, Spec } from "@origin89/equipment-schema/model";
import { englishWords, looksForeign } from "./language.ts";
import { normaliseModelName } from "./models.ts";
import { repairMojibake } from "./text.ts";
import { englishName } from "./translations.ts";
import { looksTruncated, splitValueUnit, statesNothing } from "./units.ts";

/** What a model reported reading out of a document, before anything checks it. */
export interface ReportedSpec {
  name: string;
  value: string;
  unit?: string;
  conditions?: string;
  /** The page of the document the figure was read from, carried from the window rather than asked of the model. */
  page?: number;
}

export interface ReportedProduct {
  /** The product name as the document prints it, which is not necessarily a name we hold. */
  model: string;
  specs: ReportedSpec[];
}

/**
 * A datasheet's table header carries the unit with the name — "Rated Capacity (Ah)" — so the
 * reading arrives with it there. Moving it into the unit field loses nothing and makes the figure
 * comparable; a name with no trailing unit, or one that already has a unit, is left alone.
 */
export function splitUnit(name: string, unit: string | undefined): { name: string; unit?: string } {
  if (unit?.trim()) return { name: name.trim(), unit: unit.trim() };
  const match = /^(.*?)\s*[（(]\s*([^()（）]{1,12}?)\s*[）)]\s*$/.exec(name.trim());
  if (!match) return { name: name.trim() };
  const [, bare, candidate] = match;
  // Only a unit, not a qualifier: "(Ah)" is one, "(at 25 °C)" and "(D*W*H)" are not.
  if (
    !/^[A-Za-zΩ°µ%/·.]+[0-9]?$/.test(candidate) ||
    /^(d\*w\*h|l\*w\*h|max|min|typ|optional|nominal)$/i.test(candidate)
  )
    return { name: name.trim() };
  return bare ? { name: bare, unit: candidate } : { name: name.trim() };
}

/** A stable id for a figure, so re-running an extraction rewrites rows rather than piling up duplicates. */
export function specId(modelId: string, name: string, conditions?: string): string {
  const slug = [name, conditions ?? ""]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${modelId}--${slug}`.slice(0, 160).replace(/-+$/, "");
}

/** Compare two names the way a person would: ignoring case, spacing and the punctuation between parts. */
export function sameName(a: string, b: string): boolean {
  const key = (s: string) =>
    normaliseModelName(s)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return key(a) !== "" && key(a) === key(b);
}

/**
 * Find which model a document was talking about. A figure is only attached when the document's
 * own name for the product matches a model already held for that manufacturer, by name or by one
 * of its aliases. A near match is not a match: attaching a rating to the wrong variant is how
 * somebody sizes a bank from a sheet for a different battery.
 */
export function matchModel(
  models: Model[],
  manufacturer: string,
  reported: string,
): Model | undefined {
  const ours = models.filter((m) => m.manufacturer === manufacturer);
  return (
    ours.find((m) => sameName(m.name, reported)) ??
    ours.find((m) => m.aliases.some((a) => sameName(a, reported)))
  );
}

export interface SpecsFromInput {
  reports: ReportedProduct[];
  models: Model[];
  manufacturer: string;
  source: string;
  extractedBy: string;
  /** How much weight the document itself carries, which is the ceiling on any figure taken from it. */
  confidence: Spec["confidence"];
}

export interface SpecsFromResult {
  specs: Spec[];
  /** Product names the document gave that no model of this maker answers to, kept so they can be looked at. */
  unmatched: string[];
  /** Figures refused because their value was a fragment of the JSON they were read out of. */
  truncated: string[];
  /** Figures dropped because a multilingual document stated them again in another language. */
  repeated: number;
}

/** Turn a document's reported figures into spec rows, keeping only those whose product we already hold. */
export function specsFrom({
  reports,
  models,
  manufacturer,
  source,
  extractedBy,
  confidence,
}: SpecsFromInput): SpecsFromResult {
  const specs = new Map<string, Spec>();
  const unmatched: string[] = [];
  const truncated: string[] = [];
  for (const report of reports) {
    const model = matchModel(models, manufacturer, report.model);
    if (!model) {
      if (report.model.trim() && !unmatched.includes(report.model)) unmatched.push(report.model);
      continue;
    }
    for (const s of report.specs) {
      const raw = s.name?.trim();
      const value = s.value?.trim();
      if (!raw || !value) continue;
      const split = splitUnit(raw, s.unit);
      // A name whose accents arrived as UTF-8 bytes read as Latin-1 is repaired before anything
      // keys off it, so the printed name is what the maker printed rather than what a decoder made.
      const name = repairMojibake(split.name);
      // A maker's own language reaches the same unit; a word that ended up in the unit field is
      // dropped rather than published as another quantity; and a unit glued to the value —
      // "57.6V" — is pulled off, since the number and the unit are both right already.
      const { value: cleanValue, unit } = splitValueUnit(repairMojibake(value), split.unit);
      // A value that is a piece of the JSON it was read out of is not a doubtful figure, it is not
      // a figure. Refused rather than published with a caveat nobody can resolve.
      if (looksTruncated(cleanValue) || statesNothing(cleanValue)) {
        truncated.push(`${name} = ${cleanValue}`);
        continue;
      }
      const conditions = s.conditions?.trim() || undefined;
      const id = specId(model.id, name, conditions);
      // Two rows of one document that reduce to the same figure under the same conditions are
      // one figure; the id says so, and the first reading wins.
      if (specs.has(id)) continue;
      specs.set(id, {
        id,
        model: model.id,
        name,
        ...(englishName(name) ? { english: englishName(name) as string } : {}),
        value: cleanValue,
        ...(unit ? { unit } : {}),
        ...(conditions ? { conditions } : {}),
        source,
        // The page travels with the figure. Looking it up afterwards by name matched the first
        // row of any product that used that name, which quietly cited the wrong page.
        ...(typeof s.page === "number" && s.page > 0 ? { page: s.page } : {}),
        extractedBy,
        confidence,
      });
    }
  }
  // A multilingual manual states one figure once per language. NOCO's GB150 gives the same 60 W as
  // "12 V snel opladen", "12V-Schnellladefunktion", "Chargement rapide 12V" and "Effekt", and none
  // of those four is detectably foreign on its own.
  //
  // What makes it safe to collapse them is knowing the document is multilingual, which this one
  // proves by producing at least one name that is. A Champion generator states 120 V three times
  // in one monolingual sheet — "Gasoline Volts", "Natural Gas Volts", "Propane Volts" — and those
  // are three real figures that happen to agree. Same shape, opposite meaning, and the document
  // tells them apart.
  const multilingual = [...specs.values()].some((row) => looksForeign(row.name) || row.english);
  const repeated = new Set<string>();
  const byFigure = new Map<string, Spec[]>();
  for (const spec of specs.values()) {
    const key = `${spec.model}|${spec.value}|${spec.unit ?? ""}`;
    byFigure.set(key, [...(byFigure.get(key) ?? []), spec]);
  }
  for (const rows of byFigure.values()) {
    if (rows.length < 2) continue;
    if (multilingual) {
      // Keep one: a name that does not read as foreign, and of those the plainest.
      const [keep] = [...rows].sort(
        (a, b) =>
          Number(looksForeign(a.name)) - Number(looksForeign(b.name)) ||
          englishWords(b.name) - englishWords(a.name) ||
          [...a.name].filter((c) => c.charCodeAt(0) > 127).length -
            [...b.name].filter((c) => c.charCodeAt(0) > 127).length ||
          a.id.localeCompare(b.id),
      );
      for (const row of rows) if (row.id !== keep?.id) repeated.add(row.id);
      continue;
    }
    const english = rows.filter((row) => !looksForeign(row.name));
    if (english.length > 0) {
      for (const row of rows.filter((r) => looksForeign(r.name))) repeated.add(row.id);
      continue;
    }
    // No English row, but two foreign ones the table aligns to the same English name: a NOCO
    // charger stated its battery capacity in Spanish and in French and neither was a repeat of
    // anything, so both survived and the same figure appeared twice.
    const byEnglish = new Map<string, Spec[]>();
    for (const row of rows) {
      if (!row.english) continue;
      byEnglish.set(row.english, [...(byEnglish.get(row.english) ?? []), row]);
    }
    for (const said of byEnglish.values()) for (const row of said.slice(1)) repeated.add(row.id);
  }
  for (const id of repeated) specs.delete(id);

  return {
    specs: [...specs.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unmatched,
    truncated,
    repeated: repeated.size,
  };
}

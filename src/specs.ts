import type { Model } from "../schema/model.ts";
import type { Spec } from "../schema/model.ts";
import { normaliseModelName } from "./models.ts";

/** What a model reported reading out of a document, before anything checks it. */
export interface ReportedSpec {
  name: string;
  value: string;
  unit?: string;
  conditions?: string;
}

export interface ReportedProduct {
  /** The product name as the document prints it, which is not necessarily a name we hold. */
  model: string;
  specs: ReportedSpec[];
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
  const key = (s: string) => normaliseModelName(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  return key(a) !== "" && key(a) === key(b);
}

/**
 * Find which model a document was talking about. A figure is only attached when the document's
 * own name for the product matches a model already held for that manufacturer, by name or by one
 * of its aliases. A near match is not a match: attaching a rating to the wrong variant is how
 * somebody sizes a bank from a sheet for a different battery.
 */
export function matchModel(models: Model[], manufacturer: string, reported: string): Model | undefined {
  const ours = models.filter((m) => m.manufacturer === manufacturer);
  return ours.find((m) => sameName(m.name, reported)) ?? ours.find((m) => m.aliases.some((a) => sameName(a, reported)));
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
}

/** Turn a document's reported figures into spec rows, keeping only those whose product we already hold. */
export function specsFrom({ reports, models, manufacturer, source, extractedBy, confidence }: SpecsFromInput): SpecsFromResult {
  const specs = new Map<string, Spec>();
  const unmatched: string[] = [];
  for (const report of reports) {
    const model = matchModel(models, manufacturer, report.model);
    if (!model) {
      if (report.model.trim() && !unmatched.includes(report.model)) unmatched.push(report.model);
      continue;
    }
    for (const s of report.specs) {
      const name = s.name?.trim();
      const value = s.value?.trim();
      if (!name || !value) continue;
      const conditions = s.conditions?.trim() || undefined;
      const id = specId(model.id, name, conditions);
      // Two rows of one document that reduce to the same figure under the same conditions are
      // one figure; the id says so, and the first reading wins.
      if (specs.has(id)) continue;
      specs.set(id, {
        id,
        model: model.id,
        name,
        value,
        ...(s.unit?.trim() ? { unit: s.unit.trim() } : {}),
        ...(conditions ? { conditions } : {}),
        source,
        extractedBy,
        confidence,
      });
    }
  }
  return { specs: [...specs.values()].sort((a, b) => a.id.localeCompare(b.id)), unmatched };
}

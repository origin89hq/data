import type { BatteryChemistry, Model, Spec } from "@origin89/equipment-schema/model";

/**
 * A battery's chemistry, from what its maker wrote down: a figure on its sheet that names it, or
 * the maker's own name for the model. "LiFePO4", "LFP", Victron's "LIT", "AGM", "GEL" and
 * "flooded" are the words makers use; a part number with none of them says nothing, and the
 * model keeps no chemistry rather than a likely one.
 */
export interface ChemistryEvidence {
  chemistry: BatteryChemistry;
  /** `name`, or `spec:<id>` naming the figure that states it. */
  chemistryBasis: string;
}

/** A figure whose name says it states the chemistry. */
const STATES_CHEMISTRY = /^(chemistry|battery chemistry|battery type|cell type|technology|type)$/i;

/** The chemistry a piece of the maker's text names, if any. */
export function chemistryIn(text: string): BatteryChemistry | undefined {
  const t = text.toLowerCase();
  if (/lifepo4?|life po4|lfp|lithium iron|iron phosphate/.test(t)) return "lifepo4";
  if (/\bnmc\b|li-?ion|lithium|(?<![a-z])lit(?![a-z])/.test(t)) return "lithium";
  if (/(?<![a-z])agm(?![a-z])|wagm(?![a-z])/.test(t)) return "agm";
  if (/(?<![a-z])gel(?![a-z])/.test(t)) return "gel";
  if (/flooded|wet cell/.test(t)) return "flooded";
  if (/lead[- ]acid|lead carbon/.test(t)) return "lead-acid";
  return undefined;
}

/**
 * What a model's own records say its chemistry is. A figure on the sheet comes before the name,
 * since it is the document's word rather than a token in a part number.
 */
export function chemistryOf(
  model: Pick<Model, "name" | "variant" | "family" | "aliases">,
  specs: readonly Pick<Spec, "id" | "name" | "value">[],
): ChemistryEvidence | undefined {
  for (const spec of specs) {
    if (!STATES_CHEMISTRY.test(spec.name.trim())) continue;
    const chemistry = chemistryIn(spec.value);
    if (chemistry) return { chemistry, chemistryBasis: `spec:${spec.id}` };
  }
  const named = chemistryIn(
    [model.name, model.variant ?? "", model.family ?? "", ...(model.aliases ?? [])].join(" "),
  );
  return named ? { chemistry: named, chemistryBasis: "name" } : undefined;
}

/** What `applyChemistry` did, for the recipe that ran it to report. */
export interface ChemistryOutcome {
  set: number;
  kept: number;
  none: number;
}

/**
 * Give every battery among `models` the chemistry its records state, through `write`. A model
 * that already has one keeps it unless `replace` is set, so a chemistry a person set by hand is
 * not overwritten by a pattern. The field is written beside the kind, as a record reads.
 */
export function applyChemistry(
  models: readonly Model[],
  specs: readonly Spec[],
  write: (model: Model) => void,
  replace = false,
): ChemistryOutcome {
  const specsOf = new Map<string, Spec[]>();
  for (const s of specs) specsOf.set(s.model, [...(specsOf.get(s.model) ?? []), s]);
  const outcome: ChemistryOutcome = { set: 0, kept: 0, none: 0 };
  for (const model of models) {
    if (model.kind !== "battery") continue;
    if (model.chemistry && !replace) {
      outcome.kept += 1;
      continue;
    }
    const found = chemistryOf(model, specsOf.get(model.id) ?? []);
    if (!found) {
      outcome.none += 1;
      continue;
    }
    if (found.chemistry === model.chemistry && found.chemistryBasis === model.chemistryBasis) {
      outcome.kept += 1;
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(model)) {
      if (k === "chemistry" || k === "chemistryBasis") continue;
      out[k] = v;
      if (k === "kind") Object.assign(out, found);
    }
    write(out as Model);
    outcome.set += 1;
  }
  return outcome;
}

/** A model with its chemistry gone, for a kind that is no longer a battery's. */
export function withoutChemistry(model: Model): Model {
  const { chemistry: _c, chemistryBasis: _b, ...rest } = model;
  return rest;
}

import { SHARED_MAPPING } from "@origin89/equipment-schema/mapping";
import type { Spec } from "@origin89/equipment-schema/model";
import {
  ConditionKey,
  PROPERTIES,
  PROPERTY_BY_KEY,
  type Property,
} from "@origin89/equipment-schema/properties";
import { conditionsFrom } from "./conditions.ts";
import { type PropertiesOutput, partOf } from "./properties.ts";
import type { Records } from "./records.ts";

/**
 * What a reviewer of a mapping would otherwise have to find by hand.
 *
 * A rule names figures; the build reads them under keys. Between the two, figures get lost: a
 * name the rule spells one way and the sheet another, a figure printed without its unit, a
 * temperature the key has no place for, a model filed under a kind its figures contradict, or a
 * rule that a builder bug keeps from reading at all. Each of those became a review finding once.
 * This lists them from the records themselves, every time validation runs.
 */
export interface Audit {
  /** A figure a rule names, under a key the model's kind has, that no key read: a defect in the build. */
  errors: string[];
  /** Things the author of a mapping should look at, one line each. */
  notes: string[];
}

const said = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

/** A name with its punctuation and bracketed asides gone, so "Voltage Per Unit (nominal)" and "Voltage per unit" meet. */
const bare = (name: string): string =>
  said(name)
    .replace(/[([{].*?[)\]}]/g, " ")
    .replace(/[^a-z0-9%°/]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

/**
 * Whether two names are the same once punctuation and asides are gone, or differ by one word
 * where the shorter still has two: "Nominal DC Input Voltage Range" beside "Nominal DC Input
 * Voltage", but not "Rating" beside "Surge rating".
 */
function oneStep(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = a.split(" ");
  const tb = b.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length < 2 || long.length - short.length !== 1) return false;
  let skipped = false;
  for (let i = 0, j = 0; j < long.length; j++) {
    if (short[i] === long[j]) i++;
    else if (skipped) return false;
    else skipped = true;
  }
  return true;
}

const ALL_CONDITIONS = ConditionKey.options.filter((c) => c !== "note" && c !== "stc");

const named = (spec: Spec, names: ReadonlySet<string>): boolean =>
  names.has(said(spec.name)) || (spec.english !== undefined && names.has(said(spec.english)));

export function auditMappings(records: Records, built: Pick<PropertiesOutput, "claimed">): Audit {
  const errors: string[] = [];
  const notes: string[] = [];
  const modelOf = new Map(records.models.map((m) => [m.id, m]));
  const mappings = new Map(records.mappings.map((m) => [m.id, m]));
  const shared = mappings.get(SHARED_MAPPING);
  const specsByMaker = new Map<string, Spec[]>();
  for (const spec of records.specs) {
    const maker = modelOf.get(spec.model)?.manufacturer;
    if (maker) specsByMaker.set(maker, [...(specsByMaker.get(maker) ?? []), spec]);
  }
  const kindsOf = (property: Property | undefined): readonly string[] => property?.kinds ?? [];
  const asked = new Set(PROPERTIES.flatMap((p) => p.kinds as readonly string[]));

  for (const [maker, specs] of specsByMaker) {
    const own = mappings.get(maker);
    // A maker with no file of its own is still read through the shared rules, so those are
    // audited for it; only the near-miss list, which is about extending a file, waits for one.
    if (!own && !shared) continue;
    const except = new Set((own?.except ?? []).map(said));
    const rules = [
      ...(own?.rules ?? []).map((rule, i) => ({
        rule,
        tag: `mapping ${maker} rule ${i + 1}`,
        ownRule: true,
      })),
      ...(shared?.rules ?? []).map((rule, i) => ({
        rule,
        tag: `shared rule ${i + 1} on ${maker}`,
        ownRule: false,
      })),
    ].map((r) => ({
      ...r,
      names: new Set(r.rule.names.map(said)),
      property: PROPERTY_BY_KEY.get(r.rule.key),
    }));
    const mappedBare = new Map<string, string>();
    for (const r of rules) for (const n of r.rule.names) mappedBare.set(bare(n), n);

    const unmapped = new Map<string, { name: string; count: number }>();
    for (const spec of specs) {
      const model = modelOf.get(spec.model);
      const kind = model?.kind;
      if (!kind || !asked.has(kind)) continue;
      let namedByAny = false;
      for (const r of rules) {
        if (r.rule.source && spec.source !== r.rule.source) continue;
        if (!named(spec, r.names)) continue;
        if (!r.ownRule && named(spec, except)) continue;
        // A rule for one part of a cell names the figure, so it is no near miss, but reads only a
        // value that has that part, as the builder does.
        namedByAny = true;
        if (r.rule.part !== undefined && partOf(spec.value, r.rule.part) === undefined) continue;
        const applies = kindsOf(r.property).includes(kind);
        if (applies && !built.claimed.has(spec.id))
          errors.push(
            `${r.tag}: names "${spec.name}" on ${spec.model}, a ${kind} the key ${r.rule.key} applies to, but no key read it`,
          );
        if (!applies && r.ownRule)
          notes.push(
            `${r.tag}: names "${spec.name}" on ${spec.model}, a ${kind}, which ${r.rule.key} does not apply to; the figure is not read`,
          );
      }
      if (!namedByAny) {
        const key = said(spec.name);
        const entry = unmapped.get(key) ?? { name: spec.name, count: 0 };
        entry.count += 1;
        unmapped.set(key, entry);
      }
    }
    // A name one step from a mapped one is most often the same figure spelled by another sheet.
    for (const { name, count } of own ? unmapped.values() : []) {
      const b = bare(name);
      for (const [mb, mapped] of mappedBare) {
        if (oneStep(b, mb)) {
          notes.push(
            `mapping ${maker}: "${name}" (${count} figure${count === 1 ? "" : "s"}) is one step from the mapped "${mapped}" and is not read`,
          );
          break;
        }
      }
    }
    // What each rule reads that it cannot make a value of, for reasons the rule could state.
    // What each rule reads of this maker that it cannot make a value of, for reasons the rule
    // could state; the shared rules read the maker's figures too.
    for (const r of rules) {
      const read = specs.filter(
        (s) => (!r.rule.source || s.source === r.rule.source) && named(s, r.names),
      );
      const unitless = read.filter((s) => !s.unit && !/[a-z°%]/i.test(s.value) && !r.rule.unit);
      if (unitless.length > 0)
        notes.push(
          `${r.tag} (${r.rule.key}): ${unitless.length} of ${read.length} figures print no unit and the rule names none, so they are gaps: "${unitless[0]?.name}" = "${unitless[0]?.value}" on ${unitless[0]?.model}`,
        );
      if (r.property) {
        const takes = new Set([
          ...r.property.needs,
          ...r.property.accepts,
          ...(r.rule.requires ?? []),
        ]);
        const dropped = new Map<string, number>();
        for (const s of read) {
          const stated = conditionsFrom([s.name, s.conditions ?? ""].join(" "), ALL_CONDITIONS);
          for (const c of Object.keys(stated))
            if (!takes.has(c as ConditionKey)) dropped.set(c, (dropped.get(c) ?? 0) + 1);
        }
        for (const [condition, n] of dropped)
          notes.push(
            `${r.tag} (${r.rule.key}): ${n} figure${n === 1 ? "" : "s"} state a ${condition} the key does not keep`,
          );
      }
    }
  }
  // A model's figures can contradict its kind: an inverter with a charger's output is an inverter/charger.
  for (const model of records.models) {
    if (model.kind !== "inverter") continue;
    const charger = records.specs.find(
      (s) =>
        s.model === model.id &&
        /\bcharger\b/i.test(s.name) &&
        /output/i.test(s.name) &&
        (s.unit === "A" || /\bA\b|amps/i.test(s.value)),
    );
    if (charger)
      notes.push(
        `model ${model.id} is filed as an inverter but prints a charger's output, "${charger.name}"; an inverter/charger's keys would read it`,
      );
  }
  // A generator that prints no watts and no AC voltage, or a pump no flow, head, pressure or
  // horsepower, is most often something else filed under that kind: a bare engine, a transfer
  // switch, a filter cartridge. Four such turned up in one review.
  const OUTPUT: Partial<Record<string, RegExp>> = {
    generator: /watt|\bkw\b|power|volts?\s*ac|ac\s*volts?|rated voltage|puissance|potencia/i,
    pump: /flow|gpm|lpm|head|lift|psi|pressure|\bhp\b|horsepower|capacity/i,
  };
  for (const model of records.models) {
    const pattern = model.kind ? OUTPUT[model.kind] : undefined;
    if (!pattern || model.reviewedBy) continue;
    const own = records.specs.filter((s) => s.model === model.id);
    if (own.length > 0 && !own.some((s) => pattern.test(s.name)))
      notes.push(
        `model ${model.id} is filed as a ${model.kind} but none of its ${own.length} figures is an output; it may be an engine, a switch or a part`,
      );
  }
  return { errors: errors.sort(), notes: notes.sort() };
}

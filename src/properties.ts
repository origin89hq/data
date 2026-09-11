import type { Mapping, MappingRule } from "@origin89/equipment-schema/mapping";
import type { Model, Spec } from "@origin89/equipment-schema/model";
import {
  type Basis,
  type ConditionKey,
  type Conditions,
  type GapReason,
  PROPERTIES,
  type Property,
} from "@origin89/equipment-schema/properties";
import { conditionsFrom, conditionsKey, mergeConditions, splitDuration } from "./conditions.ts";
import { type Feed, type FeedModel, feedSpecId } from "./feeds.ts";
import { type Parsed, readProperty } from "./quantities.ts";

/**
 * Build the normalized properties beside the printed figures.
 *
 * Every printed figure stays exactly as it is in `specs`. A property is one figure read under a
 * registry key by a maker's mapping rule or a feed's column, as a number in the key's unit with
 * its conditions structured. What a model's claims cannot fill is a gap with a reason, and two
 * usable values that disagree publish as a conflict, so a consumer sees why rather than an
 * absence (#82).
 */

/** One property a model has, or one of the values in conflict over it. */
export interface PropertyRow {
  model: string;
  key: string;
  status: "value" | "conflict";
  value?: number;
  min?: number;
  max?: number;
  values?: number[];
  unit: string;
  conditions: Conditions;
  scope?: "per-input" | "total";
  /** The printed figure this was read from. */
  claim: string;
  source: string;
  page?: number;
  /** The rule and version, or the feed column, that read it. */
  mappedBy: string;
  basis: Basis;
}

export interface GapRow {
  model: string;
  key: string;
  reason: GapReason;
  /** Why the claims could not fill it: the parser's reason, or the conditions missing. */
  detail?: string;
  /** How many printed figures were considered. */
  claims: number;
}

export interface CoverageRow {
  key: string;
  kind: string;
  models: number;
  /** Models with a usable value; `partial` of them also had a claim that could not be read. */
  values: number;
  partial: number;
  conflicts: number;
  noClaim: number;
  unparsed: number;
  needsConditions: number;
}

export interface PropertiesInput {
  models: readonly Model[];
  specs: readonly Spec[];
  mappings: readonly Mapping[];
  feeds: readonly { feed: Feed; model: FeedModel }[];
}

export interface PropertiesOutput {
  properties: PropertyRow[];
  gaps: GapRow[];
  coverage: CoverageRow[];
}

/** A printed figure as a candidate for one key: what to parse, and where it came from. */
interface Claim {
  id: string;
  value: string;
  unit?: string;
  text: string;
  conditions?: Conditions;
  source: string;
  page?: number;
  mappedBy: string;
  basis: Basis;
  scope?: "per-input" | "total";
  /** Conditions the rule that read it demands, beyond the key's own. */
  requires?: readonly ConditionKey[];
}

/** A name as a person reads it: case and the spacing between words do not change it. */
const said = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The SAM feed maps by column, in code. A module figure at the reference conditions carries the
 * library's own `STC` label as its conditions (#81), which is read like any other figure's words.
 * The units row leaves the STC power blank, and SAM's documentation of the CEC module model
 * states it in watts, so that column alone is read with a unit the file does not carry, under a
 * rule that says so. The MPPT window is two columns read as one range.
 */
const FEED_COLUMNS: Record<string, { key: string; unit?: string; conditions?: Conditions }> = {
  "Nameplate power at standard test conditions": { key: "panel.power.stc", unit: "W" },
  "Open-circuit voltage": { key: "panel.voc.stc" },
  "Short-circuit current": { key: "panel.isc.stc" },
  "Voltage at maximum power": { key: "panel.vmp.stc" },
  "Current at maximum power": { key: "panel.imp.stc" },
  "Temperature coefficient of open-circuit voltage": { key: "panel.voc.coefficient" },
  "Temperature coefficient of short-circuit current": { key: "panel.isc.coefficient" },
  "Temperature coefficient of maximum power": { key: "panel.power.coefficient" },
  "Maximum DC voltage": { key: "pv.voc.max" },
  "Maximum AC power output": { key: "inverter.power.continuous" },
  "Night tare loss": { key: "inverter.power.idle", conditions: { mode: "night" } },
  "AC voltage": { key: "inverter.voltage.ac" },
};
const FEED_RANGE = {
  key: "pv.mppt.window",
  min: "Lowest MPPT voltage",
  max: "Highest MPPT voltage",
} as const;

const basisOf = (spec: Pick<Spec, "reviewedBy" | "extractedBy">): Basis =>
  spec.reviewedBy ? "reviewed" : "extracted";

/** Which of a maker's rules read a printed figure under a key. */
function rulesFor(mapping: Mapping | undefined, key: string): (MappingRule & { n: number })[] {
  return (mapping?.rules ?? []).flatMap((rule, i) =>
    rule.key === key ? [{ ...rule, n: i + 1 }] : [],
  );
}

function recordClaims(key: string, specs: readonly Spec[], mapping: Mapping | undefined): Claim[] {
  const claims: Claim[] = [];
  for (const rule of rulesFor(mapping, key)) {
    const names = new Set(rule.names.map(said));
    for (const spec of specs) {
      if (rule.source && spec.source !== rule.source) continue;
      if (!names.has(said(spec.name)) && !(spec.english && names.has(said(spec.english)))) continue;
      claims.push({
        id: spec.id,
        value: spec.value,
        unit: spec.unit ?? rule.unit,
        text: [spec.name, spec.conditions ?? ""].join(" "),
        conditions: rule.conditions,
        source: spec.source,
        page: spec.page,
        mappedBy: `rule:${mapping?.id}@${mapping?.version}#${rule.n}`,
        basis: basisOf(spec),
        scope: rule.scope,
        requires: rule.requires,
      });
    }
  }
  return claims;
}

function feedClaims(feed: Feed, model: FeedModel, key: string): Claim[] {
  const claims: Claim[] = [];
  const figures = model.specs.map((spec) => ({ ...spec, id: feedSpecId(model.id, spec.name) }));
  for (const figure of figures) {
    const column = FEED_COLUMNS[figure.name];
    if (!column || column.key !== key) continue;
    claims.push({
      id: figure.id,
      value: figure.value,
      unit: figure.unit ?? column.unit,
      text: [figure.name, figure.conditions ?? ""].join(" "),
      conditions: column.conditions,
      source: model.source,
      mappedBy: `feed:${feed.id}/${figure.name}@1`,
      basis: "feed",
    });
  }
  if (key === FEED_RANGE.key) {
    const low = figures.find((f) => f.name === FEED_RANGE.min);
    const high = figures.find((f) => f.name === FEED_RANGE.max);
    if (low && high && low.unit && low.unit === high.unit)
      claims.push({
        id: low.id,
        value: `${low.value}-${high.value}`,
        unit: low.unit,
        text: `${low.name} to ${high.name}`,
        source: model.source,
        mappedBy: `feed:${feed.id}/${FEED_RANGE.min},${FEED_RANGE.max}@1`,
        basis: "feed",
      });
  }
  return claims;
}

/** A figure read: its number, its conditions, and what it lacks. */
interface Reading {
  claim: Claim;
  parsed?: Parsed;
  reason?: string;
  conditions: Conditions;
  missing: string[];
}

function read(claim: Claim, property: Property, reference: number | undefined): Reading {
  const needs = [...new Set([...property.needs, ...(claim.requires ?? [])])];
  const accepts = [...needs, ...property.accepts];
  const split = splitDuration(claim.value);
  const conditions = mergeConditions(
    claim.conditions,
    conditionsFrom(claim.text, accepts),
    split.duration !== undefined && accepts.includes("duration")
      ? { duration: split.duration }
      : undefined,
  );
  const missing = needs.filter((c) => conditions[c] === undefined);
  const result = readProperty(split.value, claim.unit, property, { reference });
  return result.ok
    ? { claim, parsed: result.parsed, conditions, missing }
    : { claim, reason: result.reason, conditions, missing };
}

const shown = (parsed: Parsed): string =>
  parsed.shape === "scalar"
    ? String(parsed.value)
    : parsed.shape === "range"
      ? `${parsed.min}-${parsed.max}`
      : parsed.values.join("/");

const BASIS_RANK: Record<Basis, number> = { reviewed: 0, feed: 1, extracted: 2 };

/**
 * The gap the readings that could not be used leave: a condition missing, or a figure unread.
 * `claims` counts every figure read for the key, the usable ones beside them included.
 */
function unread(model: string, key: string, readings: Reading[], beside: number): GapRow {
  const short = readings.find((r) => r.parsed && r.missing.length > 0);
  const aside = beside > 0 ? `, beside ${beside} usable figure${beside === 1 ? "" : "s"}` : "";
  const claims = readings.length + beside;
  if (short)
    return {
      model,
      key,
      reason: "needs-conditions",
      detail: `no ${short.missing.join(", ")} stated${aside}`,
      claims,
    };
  const [first] = readings;
  return { model, key, reason: "unparsed", detail: `${first?.reason}${aside}`, claims };
}

/** Property and gap rows for one model under one key, from the figures that reached it. */
function settle(
  model: string,
  key: string,
  readings: Reading[],
  unit: string,
  scope: Property["scope"],
): { properties: PropertyRow[]; gap?: GapRow } {
  if (readings.length === 0)
    return { properties: [], gap: { model, key, reason: "no-claim", claims: 0 } };
  const usable = readings.filter((r) => r.parsed && r.missing.length === 0);
  const unusable = readings.filter((r) => !usable.includes(r));
  if (usable.length === 0) return { properties: [], gap: unread(model, key, unusable, 0) };
  // One row per set of conditions: a capacity at C20 and at C100 are two properties. Under one
  // set, figures that agree are one property cited from the best-founded claim; figures that
  // disagree are all published, each marked, and the key is a gap until somebody decides.
  const byConditions = new Map<string, Reading[]>();
  for (const reading of usable) {
    const k = conditionsKey(reading.conditions);
    byConditions.set(k, [...(byConditions.get(k) ?? []), reading]);
  }
  const properties: PropertyRow[] = [];
  let conflicts = 0;
  for (const group of byConditions.values()) {
    const distinct = new Map<string, Reading[]>();
    for (const reading of group) {
      const seen = reading.parsed ? shown(reading.parsed) : "";
      distinct.set(seen, [...(distinct.get(seen) ?? []), reading]);
    }
    const status = distinct.size > 1 ? "conflict" : "value";
    if (status === "conflict") conflicts += 1;
    for (const agreeing of distinct.values()) {
      const [best] = [...agreeing].sort(
        (a, b) =>
          BASIS_RANK[a.claim.basis] - BASIS_RANK[b.claim.basis] ||
          a.claim.id.localeCompare(b.claim.id),
      );
      if (!best?.parsed) continue;
      const { parsed } = best;
      properties.push({
        model,
        key,
        status,
        ...(parsed.shape === "scalar" ? { value: parsed.value } : {}),
        ...(parsed.shape === "range" ? { min: parsed.min, max: parsed.max } : {}),
        ...(parsed.shape === "set" ? { values: parsed.values } : {}),
        unit,
        conditions: best.conditions,
        ...((best.claim.scope ?? scope) ? { scope: best.claim.scope ?? scope } : {}),
        claim: best.claim.id,
        source: best.claim.source,
        ...(best.claim.page !== undefined ? { page: best.claim.page } : {}),
        mappedBy: best.claim.mappedBy,
        basis: best.claim.basis,
      });
    }
  }
  // A figure that could not be read beside ones that could is still reported: a 25 °C rating
  // printed in VA next to 40 °C ratings in W is not filled by them, and a coverage that said
  // so would be counting the key as complete.
  return {
    properties,
    ...(conflicts > 0
      ? {
          gap: {
            model,
            key,
            reason: "conflict" as const,
            detail: `${conflicts} set${conflicts === 1 ? "" : "s"} of conditions with figures that disagree`,
            claims: readings.length,
          },
        }
      : unusable.length > 0
        ? { gap: unread(model, key, unusable, usable.length) }
        : {}),
  };
}

/** The keys a kind of equipment has, coefficients last so their references are read first. */
function keysFor(kind: string | undefined): Property[] {
  if (!kind) return [];
  return PROPERTIES.filter((p) => (p.kinds as readonly string[]).includes(kind)).sort(
    (a, b) =>
      Number(a.quantity === "temperature-coefficient") -
        Number(b.quantity === "temperature-coefficient") || a.key.localeCompare(b.key),
  );
}

/** The STC figure a coefficient is a share of, when the model has exactly one. */
function referenceFor(key: string, values: Map<string, number>): number | undefined {
  const stem = key.replace(/\.coefficient$/, ".stc");
  return values.get(stem);
}

export function buildProperties(input: PropertiesInput): PropertiesOutput {
  const properties: PropertyRow[] = [];
  const gaps: GapRow[] = [];
  const coverage = new Map<string, CoverageRow>();
  const tally = (key: string, kind: string) => {
    const k = `${key}\t${kind}`;
    const row = coverage.get(k) ?? {
      key,
      kind,
      models: 0,
      values: 0,
      partial: 0,
      conflicts: 0,
      noClaim: 0,
      unparsed: 0,
      needsConditions: 0,
    };
    coverage.set(k, row);
    return row;
  };
  const mappings = new Map(input.mappings.map((m) => [m.id, m]));
  const specsByModel = new Map<string, Spec[]>();
  for (const spec of input.specs)
    specsByModel.set(spec.model, [...(specsByModel.get(spec.model) ?? []), spec]);

  const settleModel = (
    id: string,
    kind: string | undefined,
    claimsFor: (property: Property) => Claim[],
  ) => {
    const values = new Map<string, number>();
    for (const property of keysFor(kind)) {
      const row = tally(property.key, kind ?? "");
      row.models += 1;
      const reference = referenceFor(property.key, values);
      const readings = claimsFor(property).map((claim) => read(claim, property, reference));
      const settled = settle(id, property.key, readings, property.unit, property.scope);
      properties.push(...settled.properties);
      const valued = settled.properties.filter((p) => p.status === "value");
      if (valued.length > 0) row.values += 1;
      if (settled.gap) {
        gaps.push(settled.gap);
        if (settled.gap.reason === "conflict") row.conflicts += 1;
        else if (valued.length > 0) row.partial += 1;
        else if (settled.gap.reason === "no-claim") row.noClaim += 1;
        else if (settled.gap.reason === "unparsed") row.unparsed += 1;
        else row.needsConditions += 1;
      }
      const [only] = valued;
      if (valued.length === 1 && only?.value !== undefined) values.set(property.key, only.value);
    }
  };

  for (const model of input.models)
    settleModel(model.id, model.kind, (property) =>
      recordClaims(
        property.key,
        specsByModel.get(model.id) ?? [],
        mappings.get(model.manufacturer),
      ),
    );
  for (const { feed, model } of input.feeds)
    settleModel(model.id, model.kind, (property) => feedClaims(feed, model, property.key));

  const byKey = (a: { model: string; key: string }, b: { model: string; key: string }) =>
    a.model.localeCompare(b.model) || a.key.localeCompare(b.key);
  return {
    properties: properties.sort((a, b) => byKey(a, b) || a.claim.localeCompare(b.claim)),
    gaps: gaps.sort(byKey),
    coverage: [...coverage.values()].sort(
      (a, b) => a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind),
    ),
  };
}

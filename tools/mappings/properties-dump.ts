import { writeFileSync } from "node:fs";
import { conditionsKey } from "../../src/conditions.ts";
import { buildProperties, type GapRow, type PropertyRow } from "../../src/properties.ts";
import { loadRecords } from "../../src/records.ts";

/**
 * Every property and gap the mappings read from the records, written to a file so a change to
 * the parser, the builder or a mapping can be read row by row rather than as a count. The
 * coverage snapshot says how many; this says which. Feeds are left out: they do not move with
 * the records, and the SAM file is not in the checkout.
 */
export interface Dump {
  properties: DumpedProperty[];
  gaps: DumpedGap[];
}
export type DumpedProperty = Pick<
  PropertyRow,
  | "model"
  | "key"
  | "status"
  | "value"
  | "min"
  | "max"
  | "values"
  | "unit"
  | "conditions"
  | "scope"
  | "claim"
>;
export type DumpedGap = Pick<GapRow, "model" | "key" | "reason" | "detail" | "claims">;

/** The row's identity across two dumps: what was read, under which key and conditions. */
export const propertyId = (p: DumpedProperty): string =>
  [p.model, p.key, p.claim, conditionsKey(p.conditions), p.scope ?? ""].join("|");
export const gapId = (g: DumpedGap): string => `${g.model}|${g.key}`;

export function dump(): Dump {
  const records = loadRecords();
  const { properties, gaps } = buildProperties({
    models: records.models,
    specs: records.specs,
    mappings: records.mappings,
    feeds: [],
  });
  return {
    properties: properties
      .map(({ model, key, status, value, min, max, values, unit, conditions, scope, claim }) => ({
        model,
        key,
        status,
        value,
        min,
        max,
        values,
        unit,
        conditions,
        scope,
        claim,
      }))
      .sort((a, b) => propertyId(a).localeCompare(propertyId(b))),
    gaps: gaps
      .filter((g) => g.claims > 0)
      .map(({ model, key, reason, detail, claims }) => ({ model, key, reason, detail, claims }))
      .sort((a, b) => gapId(a).localeCompare(gapId(b))),
  };
}

if (process.argv[1]?.endsWith("properties-dump.ts")) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("usage: properties-dump.ts <file>");
  const out = dump();
  writeFileSync(file, `${JSON.stringify(out)}\n`);
  console.log(
    `wrote ${file}: ${out.properties.length} properties, ${out.gaps.length} gaps with a claim`,
  );
}

import { buildProperties } from "../../src/properties.ts";
import type { Records } from "../../src/records.ts";

/**
 * What the mappings read from the records, as numbers a pull request carries in its diff.
 *
 * A mapping change shows its effect here before a reviewer reads a rule: the values each maker
 * gains or loses, the conflicts it opens, the gaps by reason for each key and kind. The snapshot
 * lives in `test/fixtures/property-coverage.json`; `just coverage-snapshot` rewrites it, and a
 * test fails while it is stale.
 */
export interface CoverageSnapshot {
  makers: Record<
    string,
    { values: number; conflicts: number; unparsed: number; needsConditions: number }
  >;
  keys: Record<
    string,
    {
      models: number;
      values: number;
      conflicts: number;
      unparsed: number;
      needsConditions: number;
      noClaim: number;
    }
  >;
}

export function coverageSnapshot(records: Records): CoverageSnapshot {
  const { properties, gaps, coverage } = buildProperties({
    models: records.models,
    specs: records.specs,
    mappings: records.mappings,
    feeds: [],
  });
  const makerOf = new Map(records.models.map((m) => [m.id, m.manufacturer]));
  const makers: CoverageSnapshot["makers"] = {};
  const at = (model: string) => {
    const maker = makerOf.get(model) ?? "?";
    makers[maker] ??= { values: 0, conflicts: 0, unparsed: 0, needsConditions: 0 };
    return makers[maker];
  };
  for (const p of properties) {
    if (p.status === "value") at(p.model).values += 1;
  }
  for (const g of gaps) {
    if (g.reason === "conflict") at(g.model).conflicts += 1;
    else if (g.reason === "unparsed") at(g.model).unparsed += 1;
    else if (g.reason === "needs-conditions") at(g.model).needsConditions += 1;
  }
  const keys: CoverageSnapshot["keys"] = {};
  for (const c of coverage) {
    if (c.values + c.conflicts + c.unparsed + c.needsConditions === 0) continue;
    keys[`${c.key} ${c.kind}`] = {
      models: c.models,
      values: c.values,
      conflicts: c.conflicts,
      unparsed: c.unparsed,
      needsConditions: c.needsConditions,
      noClaim: c.noClaim,
    };
  }
  const sorted = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { makers: sorted(makers), keys: sorted(keys) };
}

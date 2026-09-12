import { SHARED_MAPPING } from "@origin89/equipment-schema/mapping";
import type { Spec } from "@origin89/equipment-schema/model";
import { PROPERTIES } from "@origin89/equipment-schema/properties";
import type { Records } from "../../src/records.ts";

const said = (n: string): string => n.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A maker's figures that no rule reads: none of the maker's own rules and none of the shared
 * ones names them, on the document they come from, on a kind some key asks. A rule scoped to
 * one document leaves the same name on every other document unmapped, which is the point of
 * the scope.
 */
export function unmappedFigures(records: Records, maker: string): Spec[] {
  const own = records.mappings.find((m) => m.id === maker);
  // A shared name the maker set aside under `except` reads nothing of the maker's: it is unmapped here.
  const except = new Set((own?.except ?? []).map(said));
  const rules = records.mappings
    .filter((m) => m.id === maker || m.id === SHARED_MAPPING)
    .flatMap((m) =>
      m.rules.map((r) => ({
        names: new Set(r.names.map(said)),
        source: r.source,
        shared: m.id === SHARED_MAPPING,
      })),
    );
  const asked = new Set(PROPERTIES.flatMap((p) => p.kinds as readonly string[]));
  const modelOf = new Map(records.models.map((m) => [m.id, m]));
  const goesBy = (s: Spec, names: ReadonlySet<string>): boolean =>
    names.has(said(s.name)) || (s.english !== undefined && names.has(said(s.english)));
  const mapped = (s: Spec): boolean =>
    rules.some(
      (r) =>
        (!r.source || s.source === r.source) &&
        goesBy(s, r.names) &&
        !(r.shared && goesBy(s, except)),
    );
  return records.specs.filter((s) => {
    const m = modelOf.get(s.model);
    return m?.manufacturer === maker && m.kind !== undefined && asked.has(m.kind) && !mapped(s);
  });
}

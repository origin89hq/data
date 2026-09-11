import type { Dialect } from "@origin89/equipment-schema/dialect";
import type { DialectLink } from "@origin89/equipment-schema/model";

/**
 * The link a catalogue entry gives a model it names: the catalogue's own claim, carrying the
 * dialect's sources and confidence, and marked as a name match rather than a register match (#84).
 */
export function catalogueLink(
  dialect: Pick<Dialect, "id" | "sources" | "confidence">,
): DialectLink {
  return {
    dialect: dialect.id,
    evidence: { kind: "catalogue-name", sources: dialect.sources.map((s) => ({ ...s })) },
    confidence: dialect.confidence,
  };
}

/** How much a link's evidence says, most first: a register match beats the maker's word, which beats the catalogue naming the model. */
const STRENGTH: Record<DialectLink["evidence"]["kind"], number> = {
  "register-match": 2,
  "vendor-doc": 1,
  "catalogue-name": 0,
};

/**
 * Links by dialect, sorted by dialect id. Where two lists link one dialect the stronger evidence
 * wins whichever list it came from; between two catalogue claims the later wins, since a rerun
 * of the linker carries the dialect's current sources; between two of any other kind the first
 * stays, since a person recorded it.
 */
export function mergeLinks(...lists: readonly (readonly DialectLink[])[]): DialectLink[] {
  const byDialect = new Map<string, DialectLink>();
  for (const list of lists)
    for (const link of list) {
      const held = byDialect.get(link.dialect);
      const stronger = !held || STRENGTH[link.evidence.kind] > STRENGTH[held.evidence.kind];
      const refreshed =
        held !== undefined &&
        held.evidence.kind === "catalogue-name" &&
        link.evidence.kind === "catalogue-name";
      if (stronger || refreshed) byDialect.set(link.dialect, link);
    }
  return [...byDialect.values()].sort((a, b) => a.dialect.localeCompare(b.dialect));
}

/** Whether two link lists name the same dialects. */
export function sameDialects(a: readonly DialectLink[], b: readonly DialectLink[]): boolean {
  const ids = (list: readonly DialectLink[]) =>
    list
      .map((l) => l.dialect)
      .sort()
      .join("\n");
  return ids(a) === ids(b);
}

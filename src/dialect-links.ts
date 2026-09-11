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

/** Links by dialect, the first link to a dialect kept, sorted by dialect id. */
export function mergeLinks(...lists: readonly (readonly DialectLink[])[]): DialectLink[] {
  const byDialect = new Map<string, DialectLink>();
  for (const list of lists)
    for (const link of list) if (!byDialect.has(link.dialect)) byDialect.set(link.dialect, link);
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

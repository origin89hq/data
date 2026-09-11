import type { Dialect } from "@origin89/equipment-schema/dialect";
import type { Source } from "@origin89/equipment-schema/source";

/**
 * What the catalogue's markdown does not carry, kept across an import: a dialect's structured
 * `readings` and `codes` (#84) are written on the record by hand, so a rerun of the importer
 * takes them from the record it is about to replace, by dialect id, along with every source
 * only those rows cite. A dialect the catalogue no longer has takes nothing with it.
 */
export function withExtensions(
  parsed: readonly Dialect[],
  existing: readonly Dialect[],
  sources: readonly Source[],
  existingSources: readonly Source[],
): { dialects: Dialect[]; sources: Source[] } {
  const before = new Map(existing.map((d) => [d.id, d]));
  const dialects = parsed.map((d) => {
    const held = before.get(d.id);
    if (!held) return d;
    return {
      ...d,
      ...(held.readings ? { readings: held.readings } : {}),
      ...(held.codes ? { codes: held.codes } : {}),
    };
  });
  const cited = new Set(
    dialects.flatMap((d) => [
      ...(d.readings ?? []).map((r) => r.source),
      ...(d.codes ?? []).map((c) => c.source),
    ]),
  );
  const known = new Set(sources.map((s) => s.id));
  const kept = existingSources.filter((s) => cited.has(s.id) && !known.has(s.id));
  return {
    dialects,
    sources: [...sources, ...kept].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

import type { Dialect } from "@origin89/equipment-schema/dialect";
import type { Source } from "@origin89/equipment-schema/source";

/** Where a source points, for telling two records with one id apart. */
const locator = (s: Source) => (s.url ? `url:${s.url}` : s.path ? `path:${s.path}` : "none");

/**
 * What the catalogue's markdown does not carry, kept across an import: a dialect's structured
 * `readings` and `codes` (#84) are written on the record by hand, so a rerun of the importer
 * takes them from the record it is about to replace, by dialect id, along with every source
 * only those rows cite. A dialect the catalogue no longer has takes nothing with it. A parsed
 * source with the id of a kept one but another document behind it is refused: the kept
 * citation would otherwise resolve to the wrong document, and nothing downstream would notice.
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
  const known = new Map(sources.map((s) => [s.id, s]));
  const kept: Source[] = [];
  for (const s of existingSources) {
    if (!cited.has(s.id)) continue;
    const parsed = known.get(s.id);
    if (!parsed) kept.push(s);
    else if (locator(parsed) !== locator(s))
      throw new Error(
        `source ${s.id} is cited by a reading or code as ${locator(s)}, but the catalogue now gives that id to ${locator(parsed)}; rename one before importing`,
      );
  }
  return {
    dialects,
    sources: [...sources, ...kept].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

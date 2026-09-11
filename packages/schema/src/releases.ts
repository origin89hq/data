import { z } from "zod";

export const RecordKind = z.enum([
  "families",
  "dialects",
  "sources",
  "manufacturers",
  "brands",
  "models",
  "specs",
  "mappings",
]);
export const ReleaseId = z.string().regex(/^[a-f0-9]{64}$/);
export const FileMeta = z.object({
  rows: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: ReleaseId,
});
export const Release = z.object({
  id: ReleaseId,
  content: ReleaseId,
  attempt: z
    .string()
    .regex(/^[0-9]+$/)
    .default("1"),
  at: z.iso.datetime(),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  job: z.string().regex(/^\d+$/),
  files: z.record(z.string(), FileMeta),
});
export type Release = z.infer<typeof Release>;
export const ReleasePage = z.object({ releases: z.array(Release), cursor: z.string().optional() });
export const CompareQuery = z.object({
  from: ReleaseId,
  to: ReleaseId,
  kind: RecordKind.default("models"),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  q: z.string().trim().max(100).default(""),
  change: z.enum(["all", "added", "removed", "changed"]).default("all"),
});
const JsonObject = z.record(z.string(), z.unknown());
export const RecordChange = z.object({
  id: z.string(),
  change: z.enum(["added", "removed", "changed"]),
  fields: z.array(z.string()),
  before: JsonObject.optional(),
  after: JsonObject.optional(),
});
export const Comparison = z.object({
  from: Release,
  to: Release,
  kind: RecordKind,
  total: z.number(),
  matched: z.number(),
  counts: z.object({ added: z.number(), removed: z.number(), changed: z.number() }),
  changes: z.array(RecordChange),
  next: z.number().optional(),
  files: z.array(
    z.object({
      name: z.string(),
      change: z.enum(["added", "removed", "changed"]),
      before: FileMeta.optional(),
      after: FileMeta.optional(),
    }),
  ),
});
export type Comparison = z.infer<typeof Comparison>;
export const RECORD_SNAPSHOT_MAX = 6 * 1024 * 1024;
export const snapshotName = (kind: z.infer<typeof RecordKind>) => `records_${kind}.json`;

/** Object key order is immaterial. Array order and missing versus null remain meaningful. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
    const a = before[key],
      b = after[key];
    if (canonical(a) === canonical(b)) return [];
    const path = `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    )
      return changedFields(a as Record<string, unknown>, b as Record<string, unknown>, path);
    return [path];
  });
}

/** GitHub's two-dot comparison preserves the selected direction, including rollbacks. */
export const sourceComparison = (from: string, to: string) =>
  `https://github.com/origin89hq/offgrid-equipment/compare/${from}..${to}`;

import { readFileSync } from "node:fs";
import {
  type Dump,
  type DumpedGap,
  type DumpedProperty,
  gapId,
  propertyId,
} from "./properties-dump.ts";

/**
 * What a change moved, row by row, between two dumps of the properties: a value that appeared,
 * one that went, one that changed, and a gap whose reason changed. A count says a change moved
 * sixty figures; this says which sixty, so each can be read against its sheet before the change
 * is pushed. A review found Samlex's tolerances and SRNE's wiring notes going back to gaps this
 * way once; running it first would have found them before the review did.
 */
export interface Diff {
  added: DumpedProperty[];
  removed: DumpedProperty[];
  changed: { before: DumpedProperty; after: DumpedProperty }[];
  gaps: { before?: DumpedGap; after?: DumpedGap }[];
}

const shown = (p: DumpedProperty): string =>
  p.value !== undefined
    ? String(p.value)
    : p.values !== undefined
      ? p.values.join("/")
      : `${p.min}-${p.max}`;

export function diffDumps(before: Dump, after: Dump): Diff {
  const was = new Map(before.properties.map((p) => [propertyId(p), p]));
  const is = new Map(after.properties.map((p) => [propertyId(p), p]));
  const added = after.properties.filter((p) => !was.has(propertyId(p)));
  const removed = before.properties.filter((p) => !is.has(propertyId(p)));
  const changed: Diff["changed"] = [];
  for (const [id, b] of was) {
    const a = is.get(id);
    if (a && (shown(a) !== shown(b) || a.unit !== b.unit || a.status !== b.status))
      changed.push({ before: b, after: a });
  }
  const gapsWere = new Map(before.gaps.map((g) => [gapId(g), g]));
  const gapsAre = new Map(after.gaps.map((g) => [gapId(g), g]));
  const gaps: Diff["gaps"] = [];
  for (const [id, b] of gapsWere) {
    const a = gapsAre.get(id);
    if (!a) gaps.push({ before: b });
    else if (a.reason !== b.reason || a.detail !== b.detail) gaps.push({ before: b, after: a });
  }
  for (const [id, a] of gapsAre) if (!gapsWere.has(id)) gaps.push({ after: a });
  return { added, removed, changed, gaps };
}

const line = (p: DumpedProperty): string =>
  `${p.model} ${p.key} = ${shown(p)} ${p.unit} ${JSON.stringify(p.conditions)}${p.scope ? ` ${p.scope}` : ""}${p.status === "conflict" ? " (conflict)" : ""}  <- ${p.claim}`;

export function report(diff: Diff): string[] {
  const out: string[] = [];
  out.push(
    `${diff.added.length} properties added, ${diff.removed.length} removed, ${diff.changed.length} changed; ${diff.gaps.length} gaps moved`,
  );
  for (const p of diff.added) out.push(`+ ${line(p)}`);
  for (const p of diff.removed) out.push(`- ${line(p)}`);
  for (const { before, after } of diff.changed)
    out.push(
      `~ ${before.model} ${before.key}: ${shown(before)} ${before.unit} -> ${shown(after)} ${after.unit}  <- ${after.claim}`,
    );
  for (const { before, after } of diff.gaps) {
    const b = before ? `${before.reason}${before.detail ? ` (${before.detail})` : ""}` : "no gap";
    const a = after ? `${after.reason}${after.detail ? ` (${after.detail})` : ""}` : "no gap";
    out.push(`? ${(before ?? after)?.model} ${(before ?? after)?.key}: ${b} -> ${a}`);
  }
  return out;
}

if (process.argv[1]?.endsWith("properties-diff.ts")) {
  const [before, after] = process.argv.slice(2);
  if (!before || !after) throw new Error("usage: properties-diff.ts <before.json> <after.json>");
  const read = (file: string): Dump => JSON.parse(readFileSync(file, "utf8")) as Dump;
  for (const l of report(diffDumps(read(before), read(after)))) console.log(l);
}

import { loadRecords, type Records } from "./records.ts";
import { locatorOf } from "../tools/catalogue/sources.ts";

export interface Report {
  /** A defect. The build refuses to run while any exist. */
  errors: string[];
  /** Things a person has to look at. Counted, not refused: the catalogue was imported with them. */
  review: Record<string, number>;
}

/** Cross-record checks the schemas cannot express: every reference resolves, every source is used, every family lists its dialects once. */
export function validate(records: Records): Report {
  const errors: string[] = [];
  const review: Record<string, number> = {};
  const note = (key: string) => {
    review[key] = (review[key] ?? 0) + 1;
  };

  const dialectIds = new Set(records.dialects.map((d) => d.id));
  const sourceIds = new Set(records.sources.map((s) => s.id));
  const cited = new Set<string>();

  if (dialectIds.size !== records.dialects.length) errors.push("duplicate dialect id across families");

  for (const d of records.dialects) {
    for (const other of d.seeAlso ?? []) {
      if (!dialectIds.has(other)) errors.push(`${d.id}: see-also names ${other}, which does not exist`);
      if (other === d.id) errors.push(`${d.id}: see-also names itself`);
    }
    for (const c of d.sources) {
      if (!sourceIds.has(c.source)) errors.push(`${d.id}: cites ${c.source}, which does not exist`);
      cited.add(c.source);
    }
    if (d.driver.status === "shipped" && !d.driver.id) errors.push(`${d.id}: shipped with no driver id`);
    if (d.driver.status !== "shipped" && d.driver.id) errors.push(`${d.id}: driver id on a driver that has not shipped`);
    if (d.refiledFrom === d.family) errors.push(`${d.id}: refiled from its own family`);
    if (d.confidence === "unverified") note("confidence unverified — do not build on");
    if (d.refuter === "not-checked") note("refuter never ran");
    if (d.sharedMapClaimDropped) note("model grouping lost its evidence on review");
    if (d.refutedOnReview !== undefined) note("refuted on review");
    if (!d.models?.length) note("no model listed");
    if (d.possibleDuplicate) note("possible duplicate of a sibling id");
  }

  for (const s of records.sources) {
    if (!cited.has(s.id)) errors.push(`source ${s.id} is cited by nothing`);
    if (!s.url && !s.path) note("source with no url or path");
    if (!s.title) note("source without a title");
    if (s.redistributable === undefined) note("source licence unchecked");
  }

  const families = new Set(records.families.map((f) => f.id));
  for (const f of records.families) {
    const seen = new Set<string>();
    for (const id of f.order) {
      if (seen.has(id)) errors.push(`${f.id}: order lists ${id} twice`);
      seen.add(id);
      const d = records.dialects.find((x) => x.id === id);
      if (!d) errors.push(`${f.id}: order names ${id}, which does not exist`);
      else if (d.family !== f.id) errors.push(`${f.id}: order names ${id}, which belongs to ${d.family}`);
    }
    for (const s of f.sections ?? []) {
      if (!seen.has(s.before)) errors.push(`${f.id}: section placed before ${s.before}, which is not in its order`);
    }
  }
  for (const d of records.dialects) {
    if (!families.has(d.family)) errors.push(`${d.id}: family ${d.family} has no family record`);
    else if (!records.families.find((f) => f.id === d.family)?.order.includes(d.id)) errors.push(`${d.id}: not in ${d.family}'s order`);
  }
  return { errors, review };
}

export function reviewSummary(records: Records, report: Report): string {
  const lines = [
    `${records.families.length} families · ${records.dialects.length} dialects · ${records.sources.length} sources`,
    "",
    "For review:",
    ...Object.entries(report.review)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`),
  ];
  const unlocated = records.sources.filter((s) => !s.url && !s.path).length;
  if (unlocated) lines.push("", `${unlocated} sources are cited by title only; locatorOf() found no url or docs/ path in the citation.`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const records = loadRecords();
  const report = validate(records);
  console.log(reviewSummary(records, report));
  if (report.errors.length) {
    console.error(`\n${report.errors.length} errors:`);
    for (const e of report.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("\nvalid");
}

export { locatorOf };

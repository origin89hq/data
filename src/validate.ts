import { loadRecords, type Records } from "./records.ts";
import { locatorOf } from "../tools/catalogue/sources.ts";
import { concerns as figureConcerns } from "./units.ts";

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

  for (const m of records.manufacturers) for (const s of m.sources ?? []) cited.add(s);
  for (const s of records.specs) cited.add(s.source);
  for (const s of records.sources) {
    if (!cited.has(s.id)) errors.push(`source ${s.id} is cited by nothing`);
    if (!s.url && !s.path) note("source with no url or path");
    if (!s.title) note("source without a title");
    if (s.redistributable === undefined) note("source licence unchecked");
  }

  // Nothing may claim to have happened after today. A date read as "when this was fetched" that
  // has not arrived yet is worse than no date, and 148 source records once carried one.
  const today = new Date().toISOString().slice(0, 10);
  for (const s of records.sources) if (s.retrievedAt && s.retrievedAt > today) errors.push(`source ${s.id}: retrieved on ${s.retrievedAt}, which has not happened`);
  for (const b of records.brands) {
    if (b.evidence.seenAt > today) errors.push(`${b.id}: seen on ${b.evidence.seenAt}, which has not happened`);
    if (b.checkedAt && b.checkedAt > today) errors.push(`${b.id}: decided on ${b.checkedAt}, which has not happened`);
  }
  for (const s of records.specs) if (s.checkedAt && s.checkedAt > today) errors.push(`spec ${s.id}: confirmed on ${s.checkedAt}, which has not happened`);
  for (const m of records.models) if (m.checkedAt && m.checkedAt > today) errors.push(`${m.id}: checked on ${m.checkedAt}, which has not happened`);

  const makers = new Set(records.manufacturers.map((m) => m.id));
  if (makers.size !== records.manufacturers.length) errors.push("duplicate manufacturer id");
  const byBrandString = new Map<string, string>();
  for (const b of records.brands) {
    const key = b.brand.toLowerCase();
    const other = byBrandString.get(key);
    if (other) errors.push(`brands ${other} and ${b.id} both claim the string ${JSON.stringify(b.brand)}`);
    byBrandString.set(key, b.id);
    switch (b.decision) {
      case "manufacturer":
        if (!b.manufacturer) errors.push(`${b.id}: resolved to a manufacturer but names none`);
        else if (!makers.has(b.manufacturer)) errors.push(`${b.id}: names manufacturer ${b.manufacturer}, which does not exist`);
        if (b.reason) errors.push(`${b.id}: a resolved brand carries an out-of-scope reason`);
        break;
      case "out-of-scope":
        if (!b.reason) errors.push(`${b.id}: out of scope with no reason`);
        if (b.manufacturer) errors.push(`${b.id}: out of scope but names a manufacturer`);
        break;
      case "unresolved":
        if (b.manufacturer || b.reason) errors.push(`${b.id}: unresolved but already carries an answer`);
        if (b.checkedAt || b.reviewedBy) errors.push(`${b.id}: unresolved but marked reviewed`);
        note("brand waiting at the gate");
        break;
    }
    if (b.decision !== "unresolved" && !(b.checkedAt && b.reviewedBy)) errors.push(`${b.id}: decided with no reviewer or date; a decision has to be attributable`);
    if (b.decision !== "unresolved" && !b.basis) errors.push(`${b.id}: decided with no basis; a decision nobody can check is an assertion`);
    if (b.reviewedBy && /^ai:@cf\//.test(b.reviewedBy)) errors.push(`${b.id}: the bulk classifier named as the reviewer; its guess over a title is evidence, not a decision`);
    if (b.decision === "unresolved" && b.basis) errors.push(`${b.id}: unresolved but already carries a basis`);
  }
  for (const m of records.manufacturers) {
    if (!records.brands.some((b) => b.manufacturer === m.id)) note("manufacturer no brand string resolves to");
    if (m.domains.length === 0) note("manufacturer with no domain, so hop two cannot crawl it");
    for (const s of m.sources ?? []) if (!sourceIds.has(s)) errors.push(`${m.id}: cites ${s}, which does not exist`);
  }

  const modelIds = new Set(records.models.map((m) => m.id));
  if (modelIds.size !== records.models.length) errors.push("duplicate model id");
  const byMakerName = new Map<string, string>();
  for (const m of records.models) {
    if (!makers.has(m.manufacturer)) errors.push(`${m.id}: names manufacturer ${m.manufacturer}, which does not exist`);
    const key = `${m.manufacturer}\t${m.name.toLowerCase()}\t${(m.variant ?? "").toLowerCase()}`;
    const other = byMakerName.get(key);
    if (other) errors.push(`models ${other} and ${m.id} are the same maker, name and variant`);
    byMakerName.set(key, m.id);
    for (const d of m.dialects) if (!dialectIds.has(d)) errors.push(`${m.id}: speaks ${d}, which is not a dialect`);
    if (m.reviewedBy && !m.basis) errors.push(`${m.id}: reviewed with no basis`);
    if (!m.reviewedBy) note("model nobody has confirmed");
    if (m.dialects.length === 0) note("model with no dialect, so nothing can read it");
    if (!m.kind) note("model nothing has classified, so its kind is unknown");
    if (!records.specs.some((s) => s.model === m.id)) note("model with no rated figure");
  }
  for (const s of records.specs) {
    if (!modelIds.has(s.model)) errors.push(`spec ${s.id}: names model ${s.model}, which does not exist`);
    if (!sourceIds.has(s.source)) errors.push(`spec ${s.id}: cites ${s.source}, which does not exist`);
    cited.add(s.source);
    if (s.confidence === "unverified") note("figure from an unverified source — do not size anything on it");
    if (!s.extractedBy && !s.reviewedBy) errors.push(`spec ${s.id}: neither extracted nor reviewed, so it came from nowhere`);
    if (s.reviewedBy && !s.checkedAt) errors.push(`spec ${s.id}: confirmed with no date`);
    if (!s.reviewedBy) note("figure a model read but nobody has confirmed");
    for (const concern of figureConcerns(s)) note(`figure doubted: ${concern}`);
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
    // A no-comms dialect says there is no protocol here a controller can speak to. "possible" is
    // then a claim about a driver for nothing: 80 of 86 say it, which is what a field looks like
    // when nobody decided rather than when somebody did. `not-planned` is the enum's word for it.
    // Corrected once, and guarded so it cannot come back: a driver is not possible for a device
    // that publishes no protocol, and "not-planned" is the enum word for that.
    if (d.family === "no-comms" && d.driver.status === "possible") errors.push(`${d.id}: a no-comms dialect cannot have a possible driver, since there is no protocol to write one against`);
    // The thing this catalogue exists to answer: could somebody write a driver from this entry?
    // A dialect with no blocks is a wiring note. Volthium has four Modbus entries, one per product
    // shape, every one unverified and none carrying a register map — useful research, not a map.
    if (d.family !== "no-comms" && !d.blocks) note("a bus dialect with no register map, so it is a wiring note rather than something to implement");
    if (d.family !== "no-comms" && d.blocks && d.confidence !== "vendor-doc") note("a register map nobody has checked against the maker own document");

    // A dialect the catalogue cannot attach to a maker cannot be joined to any product.
    if (!d.manufacturer) note("a dialect names no manufacturer, so nothing can join it to a product");
    // A protocol with no model named against it describes nothing anybody can look up.
    if ((d.models ?? []).length === 0) note("a dialect names no model at all");
    if (!families.has(d.family)) errors.push(`${d.id}: family ${d.family} has no family record`);
    else if (!records.families.find((f) => f.id === d.family)?.order.includes(d.id)) errors.push(`${d.id}: not in ${d.family}'s order`);
  }
  return { errors, review };
}

export function reviewSummary(records: Records, report: Report): string {
  const lines = [
    `${records.families.length} families · ${records.dialects.length} dialects · ${records.sources.length} sources · ${records.manufacturers.length} manufacturers · ${records.brands.length} brands · ${records.models.length} models · ${records.specs.length} specs`,
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

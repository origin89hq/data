import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Model, Spec } from "@origin89/equipment-schema/model";
import { mergeLinks } from "../../src/dialect-links.ts";
import { preferredName, productKey } from "../../src/models.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";

/**
 * Fold the records that are one product filed several times into one.
 *
 * A maker writes "6000XP" on the case, its own site writes "EG4 6000xp", and a shop writes
 * "PVEG4 6000XP Inverter". Each reached the records as its own model, so the dataset claimed three
 * products where there is one, and split that product's figures three ways.
 *
 * What survives is the maker's own name; the others become aliases, and their figures and dialects
 * move across. A figure that says the same thing under the same conditions is one figure.
 *
 * Two records that disagree about what the product *is* are not merged. An OutBack MATE3-S is
 * filed once as a bms and once as a charge-controller, and picking one would settle by coin toss a
 * question the classifier got wrong twice. Those are reported instead.
 *
 * Usage: merge-models.ts [--dry-run]
 */
const dryRun = process.argv.includes("--dry-run");
const records = loadRecords();
const makerName = new Map(records.manufacturers.map((m) => [m.id, m.name]));

const groups = new Map<string, Model[]>();
for (const model of records.models) {
  const key = productKey(makerName.get(model.manufacturer) ?? model.manufacturer, model.name);
  if (!key) continue;
  const id = `${model.manufacturer}|${key}`;
  groups.set(id, [...(groups.get(id) ?? []), model]);
}

const specsOf = new Map<string, Spec[]>();
for (const spec of records.specs)
  specsOf.set(spec.model, [...(specsOf.get(spec.model) ?? []), spec]);

const merged: { keep: Model; drop: Model[] }[] = [];
const disputed: Model[][] = [];
for (const group of groups.values()) {
  if (group.length < 2) continue;
  const kinds = new Set(group.map((m) => m.kind).filter(Boolean));
  if (kinds.size > 1) {
    disputed.push(group);
    continue;
  }
  const name = preferredName(group.map((m) => m.name));
  const keep = group.find((m) => m.name === name) ?? group[0];
  if (!keep) throw new Error("Duplicate group has no keeper");
  merged.push({ keep, drop: group.filter((m) => m.id !== keep.id) });
}

let movedSpecs = 0;
let droppedSpecs = 0;
for (const { keep, drop } of merged) {
  const aliases = new Set([...keep.aliases, ...drop.flatMap((m) => [m.name, ...m.aliases])]);
  aliases.delete(keep.name);
  const survivor = Model.parse({
    ...keep,
    aliases: [...aliases].sort(),
    // A kind stated once in the group is the group's kind, wherever it was written down.
    ...(keep.kind ? {} : { kind: drop.find((m) => m.kind)?.kind }),
    dialects: mergeLinks(keep.dialects, ...drop.map((m) => m.dialects)),
  });
  if (!dryRun) writeRecord(RECORDS_DIR, "models", keep.id, survivor);

  // The figures follow the product. A spec's id carries its model, so each one is rewritten onto
  // the survivor; where that collides with a figure the survivor already has, the survivor's wins.
  const held = new Set((specsOf.get(keep.id) ?? []).map((s) => s.id));
  for (const loser of drop) {
    for (const spec of specsOf.get(loser.id) ?? []) {
      const id = spec.id.replace(loser.id, keep.id);
      if (held.has(id)) {
        droppedSpecs += 1;
      } else {
        held.add(id);
        movedSpecs += 1;
        if (!dryRun)
          writeRecord(RECORDS_DIR, "specs", id, Spec.parse({ ...spec, id, model: keep.id }));
      }
      if (!dryRun) rmSync(join(RECORDS_DIR, "specs", `${spec.id}.json`), { force: true });
    }
    if (!dryRun) rmSync(join(RECORDS_DIR, "models", `${loser.id}.json`), { force: true });
  }
}

// A figure dropped as a repeat can be the only thing citing its document, and a source nothing
// cites is an orphan the validator refuses.
let orphans = 0;
if (!dryRun) {
  const after = loadRecords();
  const cited = new Set(after.specs.map((spec) => spec.source));
  for (const source of after.sources) {
    if (!source.id.startsWith("doc-") || cited.has(source.id)) continue;
    rmSync(join(RECORDS_DIR, "sources", `${source.id}.json`), { force: true });
    orphans += 1;
  }
}

console.log(`${records.models.length} models in`);
console.log(
  `  ${merged.length} groups merged, ${merged.reduce((n, g) => n + g.drop.length, 0)} records folded into the name the maker uses`,
);
console.log(
  `  ${movedSpecs} figures moved to the surviving model, ${droppedSpecs} dropped as the same figure said twice`,
);
for (const { keep, drop } of merged.slice(0, 12)) {
  console.log(`      ${keep.id}  ←  ${drop.map((m) => JSON.stringify(m.name)).join(", ")}`);
}
if (disputed.length) {
  console.log(
    `\n${disputed.length} groups left alone because their records disagree about what the product is:`,
  );
  for (const group of disputed) {
    const first = group[0];
    if (!first) throw new Error("Disputed group is empty");
    console.log(
      `  ${first.manufacturer}: ${group.map((m) => `${JSON.stringify(m.name)} ${m.kind ?? "no kind"}`).join("  |  ")}`,
    );
  }
  console.log(
    "  A duplicate that two answers disagree about is a classification to settle, not a merge to force.",
  );
}
if (orphans)
  console.log(
    `  ${orphans} source documents dropped, cited by nothing once their figure was a repeat`,
  );
if (dryRun) console.log("\nnothing written");
else {
  const left = readdirSync(join(RECORDS_DIR, "models")).length;
  console.log(`\n${left} model records on disk`);
}

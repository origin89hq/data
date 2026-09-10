import { Model } from "@origin89/equipment-schema/model";
import { looksLikeModelName, modelId, normaliseModelName, productKey } from "../../src/models.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";

/**
 * Join the protocol catalogue to the equipment it describes.
 *
 * A dialect names its models in prose — "Phoenix Inverter VE.Direct, all ratings, when connected to
 * a GX device rather than read directly" — so 1,124 entries reached no model record at all and the
 * question a reader most wants to ask, what can this device talk, could not be answered.
 *
 * The note is kept. What is added is the link: the leading part of each entry, where that reads as
 * a model name, matched against the models this maker already has.
 *
 * A name the catalogue states and the model table lacks becomes a model. That is the same rule
 * `pull-specs` uses for a product named in a maker's own datasheet: a reviewed protocol record
 * naming "SmartSolar MPPT 150/35" is better evidence the product exists than a shop listing is.
 *
 * Usage: link-dialects.ts [--dry-run] [--mint]
 */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
// Minting is opt-in, because the head of a note is not reliably a model of that maker. The
// dialect `magnum-ags-honda-eu3000is-combination-switch` is Magnum's, and the product it names is
// a Honda generator; minting would have filed an EU3000is under Magnum. Others are ranges
// ("8/10/12RESV") or two part numbers joined. Unmatched names are reported for a person instead.
const addModels = args.includes("--mint");

const records = loadRecords();
const makerName = new Map(records.manufacturers.map((m) => [m.id, m.name]));
const key = (maker: string, name: string) =>
  `${maker}|${productKey(makerName.get(maker) ?? maker, name)}`;

const byKey = new Map<string, string>();
for (const model of records.models) {
  for (const name of [model.name, ...model.aliases]) {
    const id = key(model.manufacturer, name);
    if (!byKey.has(id)) byKey.set(id, model.id);
  }
}

/** The model name at the head of a catalogue note, before the explanation starts. */
function headOf(entry: string): string {
  const head = entry.split(/\s+[—–-]\s+|[(,]/)[0] ?? "";
  return normaliseModelName(head.trim());
}

let linked = 0;
let minted = 0;
let prose = 0;
let noMaker = 0;
const dialectLinks = new Map<string, Set<string>>();
const unmatched = new Map<string, number>();

for (const dialect of records.dialects) {
  for (const entry of dialect.models ?? []) {
    const head = headOf(entry.name);
    if (!looksLikeModelName(head)) {
      prose += 1;
      continue;
    }
    if (!dialect.manufacturer) {
      noMaker += 1;
      continue;
    }
    let modelIdentifier = byKey.get(key(dialect.manufacturer, head));
    if (!modelIdentifier && addModels) {
      const id = modelId(dialect.manufacturer, head);
      if (!records.models.some((m) => m.id === id)) {
        const model = Model.parse({
          id,
          manufacturer: dialect.manufacturer,
          name: head,
          aliases: [],
          dialects: [],
          basis: `named by the protocol catalogue in ${dialect.id}`,
        });
        if (!dryRun) writeRecord(RECORDS_DIR, "models", id, model);
        records.models.push(model);
        byKey.set(key(dialect.manufacturer, head), id);
        minted += 1;
      }
      modelIdentifier = id;
    }
    if (!modelIdentifier) {
      unmatched.set(
        `${dialect.manufacturer}: ${head}`,
        (unmatched.get(`${dialect.manufacturer}: ${head}`) ?? 0) + 1,
      );
      continue;
    }
    dialectLinks.set(
      modelIdentifier,
      (dialectLinks.get(modelIdentifier) ?? new Set()).add(dialect.id),
    );
    linked += 1;
  }
}

// The link is written on the model, where `dialects` already exists and the reader looks first.
let touched = 0;
for (const model of records.models) {
  const found = dialectLinks.get(model.id);
  if (!found) continue;
  const dialects = [...new Set([...model.dialects, ...found])].sort();
  if (
    dialects.length === model.dialects.length &&
    dialects.every((d, i) => d === model.dialects[i])
  )
    continue;
  if (!dryRun) writeRecord(RECORDS_DIR, "models", model.id, Model.parse({ ...model, dialects }));
  touched += 1;
}

console.log(
  `${linked} model entries linked to a record${dryRun ? " (dry run, nothing written)" : ""}`,
);
if (minted)
  console.log(`  ${minted} models minted, named by the catalogue and absent from the model table`);
if (unmatched.size) {
  console.log(
    `  ${unmatched.size} names the catalogue states and the model table lacks, for review:`,
  );
  for (const [name, n] of [...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 12))
    console.log(`      ${n}x  ${name}`);
}
console.log(`  ${touched} models now point at a dialect`);
console.log(`  ${prose} entries are prose rather than a name, and stay as the note they are`);
if (noMaker) console.log(`  ${noMaker} sit on a dialect whose maker this repo holds no record for`);

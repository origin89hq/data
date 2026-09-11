import { modelKey } from "@origin89/equipment-api/keys";
import { type DialectLink, Model } from "@origin89/equipment-schema/model";
import { catalogueLink, mergeLinks, sameDialects } from "../../src/dialect-links.ts";
import { looksLikeModelName, modelId, normaliseModelName } from "../../src/models.ts";
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
const brandsOf = new Map<string, string[]>();
for (const b of records.brands)
  if (b.decision === "manufacturer" && b.manufacturer)
    brandsOf.set(b.manufacturer, [...(brandsOf.get(b.manufacturer) ?? []), b.brand]);
// The one key rule (#83), under the maker's name and each brand the gate confirmed for it. A key
// that reaches two models is kept as the set it reaches, and such a name links nothing.
const key = (maker: string, name: string) => modelKey(makerName.get(maker) ?? maker, name);
const byKey = new Map<string, Set<string>>();
const reach = (k: string, id: string) => byKey.set(k, (byKey.get(k) ?? new Set()).add(id));
for (const model of records.models) {
  const labels = [
    makerName.get(model.manufacturer) ?? model.manufacturer,
    ...(brandsOf.get(model.manufacturer) ?? []),
  ];
  for (const label of labels)
    for (const name of [model.name, ...model.aliases]) reach(modelKey(label, name), model.id);
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
let ambiguous = 0;
const dialectLinks = new Map<string, DialectLink[]>();
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
    const reached = byKey.get(key(dialect.manufacturer, head));
    if (reached && reached.size > 1) {
      ambiguous += 1;
      unmatched.set(
        `${dialect.manufacturer}: ${head} (reaches ${[...reached].sort().join(", ")})`,
        (unmatched.get(
          `${dialect.manufacturer}: ${head} (reaches ${[...reached].sort().join(", ")})`,
        ) ?? 0) + 1,
      );
      continue;
    }
    let modelIdentifier = reached ? [...reached][0] : undefined;
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
        reach(key(dialect.manufacturer, head), id);
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
      mergeLinks(dialectLinks.get(modelIdentifier) ?? [], [catalogueLink(dialect)]),
    );
    linked += 1;
  }
}

// The link is written on the model, where `dialects` already exists and the reader looks first.
let touched = 0;
for (const model of records.models) {
  const found = dialectLinks.get(model.id);
  if (!found) continue;
  // A link the model already has is left as it is: the catalogue's claim never replaces
  // stronger evidence somebody recorded.
  const dialects = mergeLinks(model.dialects, found);
  if (sameDialects(dialects, model.dialects)) continue;
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
if (ambiguous)
  console.log(
    `  ${ambiguous} names reach more than one model under the key rule, and link nothing`,
  );

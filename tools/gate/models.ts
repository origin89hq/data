import type { Guess } from "@origin89/equipment-schema/guess";
import type { Model } from "@origin89/equipment-schema/model";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import { type FoldOutcome, foldDerived } from "../../src/model-records.ts";
import { deriveModels } from "../../src/models.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";
import { readCrawl } from "./archive.ts";

/**
 * Derive model records from one or more crawls. A listing contributes only when its brand string
 * has been resolved to a manufacturer at the gate, so this runs after the gate and not before.
 *
 * Nothing derived here is reviewed. A model that already carries a reviewer keeps everything a
 * person put on it — the name, the variant, the dialects, the basis — and only its aliases grow.
 * A name a held model already answers to under another spelling becomes its alias rather than a
 * second record, including a model written earlier in the same run.
 *
 * Usage: models.ts <date> <seller...> [--remote] [--dry-run]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const [date, ...sellers] = args.filter((a) => !a.startsWith("--"));
if (!date || sellers.length === 0) {
  console.error("usage: models.ts <date> <seller...> [--remote] [--dry-run]");
  process.exit(2);
}

const sightings: Sighting[] = [];
const guesses = new Map<string, Guess>();
for (const seller of sellers) {
  const crawl = await readCrawl(seller, date, remote);
  if (!crawl) {
    console.error(`${seller}: no crawl at ${date}`);
    continue;
  }
  if (crawl.missingParts.length) {
    console.error(
      `${seller}: the crawl is incomplete (${crawl.missingParts.join(", ")}); deriving anyway, those models get no kind`,
    );
  }
  sightings.push(...crawl.sightings);
  for (const [k, v] of crawl.guesses) guesses.set(k, v);
}

const records = loadRecords();
const derived = deriveModels({
  sightings,
  guesses,
  brands: records.brands,
  dialects: records.dialects,
});
/** Every name a maker goes by, so one in front of a product name still reaches the model. */
const makerNames = [
  ...records.manufacturers.map((m) => m.name),
  ...records.brands.flatMap((b) => (b.decision === "manufacturer" ? [b.brand] : [])),
];
const held = new Map<string, Map<string, Model>>();
for (const model of records.models)
  held.set(model.manufacturer, (held.get(model.manufacturer) ?? new Map()).set(model.id, model));

const counts: Record<FoldOutcome, number> = { added: 0, refreshed: 0, folded: 0 };
for (const { model } of derived) {
  const ours = held.get(model.manufacturer) ?? new Map<string, Model>();
  const { record, outcome } = foldDerived([...ours.values()], model, makerNames);
  held.set(model.manufacturer, ours.set(record.id, record));
  if (!dryRun) writeRecord(RECORDS_DIR, "models", record.id, record);
  counts[outcome] += 1;
}

const withDialect = derived.filter((d) => d.model.dialects.length > 0).length;
const kinds = new Map<string, number>();
for (const d of derived) {
  const kind = d.model.kind ?? "(no kind)";
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}
console.log(
  `${sightings.length} sightings from ${sellers.length} sellers → ${derived.length} models${dryRun ? " (dry run, nothing written)" : ""}: ${counts.added} new, ${counts.refreshed} refreshed, ${counts.folded} folded into a model held under another spelling`,
);
console.log(`${withDialect} join a dialect this repo already documents`);
console.log(
  [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`)
    .join("\n"),
);

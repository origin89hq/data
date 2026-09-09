import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { specsFrom, type ReportedProduct } from "../../src/specs.ts";
import { looksLikeModelName, modelId, normaliseModelName } from "../../src/models.ts";
import { Model } from "../../schema/model.ts";
import { Source } from "../../schema/source.ts";
import { object } from "./archive.ts";
import { EXTRACTOR_ID } from "../../scraper/src/reading.ts";

/**
 * Fold a manufacturer's extracted readings into spec records. A figure is written only when the
 * document's own name for the product answers to a model held for that maker, and every row keeps
 * the document it came from and the page it was read off.
 *
 * A product the maker's own document names and no shop we crawled sells becomes a model first:
 * a datasheet naming "S48-300LFP STACK-LV" is better evidence that the product exists than a
 * listing is, and refusing to hold it would throw away most of a maker's range.
 *
 * Usage: pull-specs.ts <manufacturer> <date> [--remote] [--dry-run] [--no-new-models]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const [manufacturer, date] = args.filter((a) => !a.startsWith("--"));
if (!manufacturer || !date) {
  console.error("usage: pull-specs.ts <manufacturer> <date> [--remote] [--dry-run]");
  process.exit(2);
}

const key = `documents/${manufacturer}/${date}/specs.${EXTRACTOR_ID.replace(/[^\w.-]+/g, "_")}.json`;
const body = object(key, remote);
if (!body) {
  console.error(`no readings at ${key}; convert and extract first`);
  process.exit(1);
}
const readings = JSON.parse(body) as {
  readings: { sha256: string; url: string; products: (ReportedProduct & { specs: { page?: number }[] })[] }[];
};

const records = loadRecords();
const sources = new Map(records.sources.map((s) => [s.id, s]));
const addModels = !args.includes("--no-new-models");
let written = 0;
let modelsAdded = 0;
const unmatched = new Set<string>();
const rejected = new Set<string>();

if (addModels) {
  // A pass over the documents first, so a figure found in the same run has a model to attach to.
  for (const document of readings.readings) {
    for (const product of document.products) {
      const name = normaliseModelName(product.model ?? "");
      if (!looksLikeModelName(name)) {
        if (name) rejected.add(name);
        continue;
      }
      const id = modelId(manufacturer, name);
      if (records.models.some((m) => m.id === id)) continue;
      const model = Model.parse({ id, manufacturer, name, aliases: [], dialects: [] });
      if (!dryRun) writeRecord(RECORDS_DIR, "models", id, model);
      records.models.push(model);
      modelsAdded += 1;
    }
  }
}

for (const document of readings.readings) {
  if (document.products.length === 0) continue;
  // One source record per archived document, named by its content hash so two shops linking the
  // same PDF cite one source rather than two.
  const sourceId = `doc-${document.sha256.slice(0, 32)}`;
  if (!sources.has(sourceId)) {
    const source = Source.parse({ id: sourceId, url: document.url, sha256: document.sha256, retrievedAt: date });
    if (!dryRun) writeRecord(RECORDS_DIR, "sources", sourceId, source);
    sources.set(sourceId, source);
  }
  const { specs, unmatched: missing } = specsFrom({
    reports: document.products,
    models: records.models,
    manufacturer,
    source: sourceId,
    extractedBy: EXTRACTOR_ID,
    // A manufacturer's own document is a vendor document. What the figure is not is confirmed:
    // `extractedBy` with no reviewer says a model read it and nobody has checked the row.
    confidence: "vendor-doc",
  });
  for (const spec of specs) {
    if (!dryRun) writeRecord(RECORDS_DIR, "specs", spec.id, spec);
    written += 1;
  }
  for (const m of missing) unmatched.add(m);
}

console.log(`${written} figures and ${modelsAdded} new models${dryRun ? " (dry run, nothing written)" : " written"} for ${manufacturer}`);
if (unmatched.size) {
  console.log(`\n${unmatched.size} products the documents name that still reach no model:`);
  for (const m of [...unmatched].sort().slice(0, 25)) console.log(`  ${m}`);
}
if (rejected.size) {
  console.log(`\n${rejected.size} product names too sentence-like to hold as models:`);
  for (const m of [...rejected].sort().slice(0, 10)) console.log(`  ${m}`);
}

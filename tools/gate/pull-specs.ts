import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { specsFrom, type ReportedProduct } from "../../src/specs.ts";
import { looksLikeModelName, modelId, normaliseModelName } from "../../src/models.ts";
import { Model } from "../../schema/model.ts";
import { Source } from "../../schema/source.ts";
import { jsonValues, object, under } from "./archive.ts";
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

// One reading per document, written by the consumer that read it. The converting index says
// which documents to expect, so a document still on the queue shows as pending rather than as
// a maker with fewer figures than it has.
const extractor = EXTRACTOR_ID.replace(/[^\w.-]+/g, "_");
const index = await object(`documents/${manufacturer}/${date}/converting.json`, remote);
if (!index) {
  console.error(`no conversion started for ${manufacturer} at ${date}; approve the documents and convert first`);
  process.exit(1);
}
const expected = (JSON.parse(index) as { documents: { sha256: string }[] }).documents;
const readings: { readings: { sha256: string; url: string; products: (ReportedProduct & { specs: { page?: number }[] })[] }[] } = { readings: [] };
// Every reading of this run in one request, rather than one process per document.
for (const value of jsonValues<(typeof readings.readings)[number]>(await under(`documents/${manufacturer}/${date}/readings/${extractor}/`, remote))) {
  readings.readings.push(value);
}
const pending = expected.length - readings.readings.length;

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

// Every figure first, then the sources. Two datasheets can state the same figure for the same
// model, and the id is the model and the figure, so the later document wins — writing each
// document's source as it went left the earlier one cited by nothing.
const collected = new Map<string, ReturnType<typeof specsFrom>["specs"][number]>();
const usedSources = new Map<string, { url: string; sha256: string }>();
for (const document of readings.readings) {
  if (document.products.length === 0) continue;
  const sourceId = `doc-${document.sha256.slice(0, 32)}`;
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
  for (const spec of specs) collected.set(spec.id, spec);
  usedSources.set(sourceId, { url: document.url, sha256: document.sha256 });
  for (const m of missing) unmatched.add(m);
}

const cited = new Set([...collected.values()].map((s) => s.source));
for (const [sourceId, document] of usedSources) {
  if (!cited.has(sourceId) || sources.has(sourceId)) continue;
  const source = Source.parse({ id: sourceId, url: document.url, sha256: document.sha256, retrievedAt: date });
  if (!dryRun) writeRecord(RECORDS_DIR, "sources", sourceId, source);
  sources.set(sourceId, source);
}
for (const spec of collected.values()) {
  if (!dryRun) writeRecord(RECORDS_DIR, "specs", spec.id, spec);
  written += 1;
}

console.log(`${written} figures and ${modelsAdded} new models${dryRun ? " (dry run, nothing written)" : " written"} for ${manufacturer}`);
console.log(`${readings.readings.length} of ${expected.length} documents read${pending ? `, ${pending} still converting, queued or dead-lettered` : ""}`);
if (unmatched.size) {
  console.log(`\n${unmatched.size} products the documents name that still reach no model:`);
  for (const m of [...unmatched].sort().slice(0, 25)) console.log(`  ${m}`);
}
if (rejected.size) {
  console.log(`\n${rejected.size} product names too sentence-like to hold as models:`);
  for (const m of [...rejected].sort().slice(0, 10)) console.log(`  ${m}`);
}

import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { specsFrom, type ReportedProduct } from "../../src/specs.ts";
import { looksLikeModelName, modelId, normaliseModelName } from "../../src/models.ts";
import { Model } from "../../schema/model.ts";
import { Source } from "../../schema/source.ts";
import { currentRun, jsonValues, object, under } from "./archive.ts";
import { EXTRACTOR_ID } from "../../worker/src/reading.ts";
import { withoutTranslations } from "../../worker/src/documents.ts";
import { withoutTranslatedReadings, withoutRedundantTranslations } from "../../src/language.ts";

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
// Every reading of this run, whichever reader produced it: a model over prose and a parser over
// the maker's own table both land here, and each row records which one it was.
// A maker may have specification pages and no approved documents at all, so a missing conversion
// index is not a reason to stop; it only means nothing was downloaded.
// Whichever run the pointer says is current, never whichever shares a date. Two runs of one
// maker used to land in one directory and their readings were merged as though one answer.
const current = await currentRun("documents", manufacturer, remote);
if (!current) {
  console.error(`no current run for ${manufacturer}`);
  process.exit(1);
}
const base = `documents/${manufacturer}/runs/${current.run}`;
const index = await object(`${base}/converting.json`, remote);
const converting = index ? (JSON.parse(index) as { documents: { sha256: string }[] }) : undefined;
const expected = converting?.documents ?? [];
// When the bytes were actually fetched, which the crawl records. The date in the path is a name
// for the run and a person picks those loosely; a source that claims a day which has not happened
// is worse than one that claims none.
const manifest = await object(`${base}/manifest.json`, remote);
const retrievedAt = manifest ? ((JSON.parse(manifest) as { retrievedAt?: string }).retrievedAt ?? undefined) : undefined;
const readings: { readings: { sha256: string; url: string; extractedBy?: string; products: (ReportedProduct & { specs: { page?: number }[] })[] }[] } = { readings: [] };
// Every reading of this run in one request, rather than one process per document.
// A reading lives beside its document, so this run's readings are those of the documents it
// converted. Nothing is re-read because a run asked again.
for (const doc of expected) {
  for (const reader of [EXTRACTOR_ID.replace(/[^\w.-]+/g, "_"), "table_spec-table_v1"]) {
    const body = await object(`archive/${doc.sha256}.${reader}.reading.json`, remote);
    if (body) for (const value of jsonValues<(typeof readings.readings)[number]>(body)) readings.readings.push(value);
  }
}
const pending = expected.length - readings.readings.length;

// A translation is the same specification said again. Sol-Ark publishes the 8K manual in Spanish
// and in English, and reading both gave that inverter a nominal voltage of 48 V twice, once as
// "Nominal system voltage" and once as "Voltaje nominal". Dropped only when this maker also
// publishes something not marked as a translation.
const { keep, dropped } = withoutTranslations(readings.readings);
readings.readings = keep;
// And the ones whose file name says nothing. Pentair marks a Spanish manual "_SPA_" in one place
// and "-s-" in another, so the language a document is in is read off what it stated, not its name.
const byLanguage = withoutTranslatedReadings(readings.readings, (r) => r.products.flatMap((p) => p.specs.map((x) => (x as { name?: string }).name ?? "")));
readings.readings = byLanguage.keep;

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
let repeatedTotal = 0;
for (const document of readings.readings) {
  if (document.products.length === 0) continue;
  const sourceId = `doc-${document.sha256.slice(0, 32)}`;
  const { specs, unmatched: missing, repeated } = specsFrom({
    reports: document.products,
    models: records.models,
    manufacturer,
    source: sourceId,
    extractedBy: document.extractedBy ?? EXTRACTOR_ID,
    // A manufacturer's own document is a vendor document. What the figure is not is confirmed:
    // `extractedBy` with no reviewer says a model read it and nobody has checked the row.
    confidence: "vendor-doc",
  });
  repeatedTotal += repeated;
  for (const spec of specs) collected.set(spec.id, spec);
  // Only a document that produced a figure is cited. Refusing a fragment or a repeat can empty a
  // document, and a source nothing cites is an orphan the validator refuses.
  if (specs.length > 0) usedSources.set(sourceId, { url: document.url, sha256: document.sha256 });
  for (const m of missing) unmatched.add(m);
}

// Once the maker's whole set is in hand: a foreign-named figure on a model that already has
// English ones is a multilingual manual saying the same thing twice.
const aligned = withoutRedundantTranslations([...collected.values()]);
collected.clear();
for (const spec of aligned.keep) collected.set(spec.id, spec);

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
for (const { url, language } of dropped) console.log(`  skipped the ${language} edition, which this maker also publishes in English: ${url.split("/").pop()}`);
for (const reading of byLanguage.dropped) console.log(`  skipped a translated edition its file name did not declare: ${reading.url.split("/").pop()}`);
if (repeatedTotal) console.log(`  ${repeatedTotal} figures dropped where a multilingual document stated them again in another language`);
if (aligned.dropped.length) console.log(`  ${aligned.dropped.length} figures dropped: named in another language on a model that already has English figures`);
if (aligned.kept.length) {
  console.log(`  ${aligned.kept.length} figures kept with a name nobody has translated, because their model has no English figure at all:`);
  for (const spec of [...new Set(aligned.kept.map((s) => s.name))].slice(0, 10)) console.log(`      ${spec}`);
}
const byReader = new Map<string, number>();
for (const r of readings.readings) byReader.set(r.extractedBy ?? EXTRACTOR_ID, (byReader.get(r.extractedBy ?? EXTRACTOR_ID) ?? 0) + 1);
console.log(`${readings.readings.length} readings${pending > 0 ? `, ${pending} approved documents still converting or queued` : ""}`);
for (const [reader, n] of byReader) console.log(`  ${n} by ${reader}`);
if (unmatched.size) {
  console.log(`\n${unmatched.size} products the documents name that still reach no model:`);
  for (const m of [...unmatched].sort().slice(0, 25)) console.log(`  ${m}`);
}
if (rejected.size) {
  console.log(`\n${rejected.size} product names too sentence-like to hold as models:`);
  for (const m of [...rejected].sort().slice(0, 10)) console.log(`  ${m}`);
}

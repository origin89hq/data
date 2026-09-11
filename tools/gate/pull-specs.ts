import { rmSync } from "node:fs";
import { join } from "node:path";
import { withoutTranslations } from "@origin89/equipment-schema/documents";
import { Model } from "@origin89/equipment-schema/model";
import { EXTRACTOR_ID } from "@origin89/equipment-schema/provenance";
import { Source } from "@origin89/equipment-schema/source";
import { withoutRedundantTranslations, withoutTranslatedReadings } from "../../src/language.ts";
import { looksLikeModelName, modelId, normaliseModelName } from "../../src/models.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";
import { matchModel, type ReportedProduct, specsFrom } from "../../src/specs.ts";
import { currentRun, jsonValues, object, PULLED_READERS, readingsOf } from "./archive.ts";
import { creditedReadings, textKey } from "./retailer.ts";

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
const readings: {
  readings: {
    sha256: string;
    url: string;
    extractedBy?: string;
    products: (ReportedProduct & { specs: { page?: number }[] })[];
  }[];
} = { readings: [] };
// A reading lives beside its document, so this run's readings are those of the documents it
// converted. Nothing is re-read because a run asked again.
// A document may answer more than once: the text reader's and the table parser's readings both
// land here. The page reader's readings do not while `PULL_PAGE_READER` keeps them out.
// They come back in batches rather than one document at a time. Asking per document was a round
// trip each, and four thousand documents across three readers is thirteen thousand of them; the
// daily pull spent twenty-eight minutes on it and was climbing towards its hour.
const refused: { url: string; refused: string }[] = [];
for (const value of jsonValues<(typeof readings.readings)[number] & { refused?: string }>(
  await readingsOf(
    expected.map((doc) => doc.sha256),
    PULLED_READERS,
    remote,
  ),
)) {
  readings.readings.push(value);
  if (value.refused) refused.push({ url: value.url, refused: value.refused });
}

// Documents with no reading by anybody yet. Counting readings instead went wrong the day a
// document could have two.
const readShas = new Set(readings.readings.map((r) => r.sha256));
const pending = expected.filter((doc) => !readShas.has(doc.sha256)).length;

// A translation is the same specification said again. Sol-Ark publishes the 8K manual in Spanish
// and in English, and reading both gave that inverter a nominal voltage of 48 V twice, once as
// "Nominal system voltage" and once as "Voltaje nominal". Dropped only when this maker also
// publishes something not marked as a translation.
const { keep, dropped } = withoutTranslations(readings.readings);
readings.readings = keep;
// And the ones whose file name says nothing. Pentair marks a Spanish manual "_SPA_" in one place
// and "-s-" in another, so the language a document is in is read off what it stated, not its name.
const byLanguage = withoutTranslatedReadings(readings.readings, (r) =>
  r.products.flatMap((p) => p.specs.map((x) => (x as { name?: string }).name ?? "")),
);
readings.readings = byLanguage.keep;

const records = loadRecords();
// A retailer's run holds its suppliers' documents beside its own, and only those that name it
// are its own. The rest are withheld and listed, not written under the shop (#30).
const credited = await creditedReadings(
  records.manufacturers.find((m) => m.id === manufacturer),
  records.brands,
  readings.readings,
  (reading) => object(textKey(reading), remote),
);
readings.readings = credited.keep;
const withheld = credited.withheld;
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
      // New only if the match the figures use below finds nothing. That match reads through
      // punctuation and case, so SRNE's "RM-12" is its RM12; comparing ids made an empty "rm-12"
      // model beside the "rm12" its figures went to.
      if (records.models.some((m) => m.id === id) || matchModel(records.models, manufacturer, name))
        continue;
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
  const {
    specs,
    unmatched: missing,
    repeated,
  } = specsFrom({
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
  const source = Source.parse({
    id: sourceId,
    url: document.url,
    sha256: document.sha256,
    retrievedAt: date,
  });
  if (!dryRun) writeRecord(RECORDS_DIR, "sources", sourceId, source);
  sources.set(sourceId, source);
}
for (const spec of collected.values()) {
  if (!dryRun) writeRecord(RECORDS_DIR, "specs", spec.id, spec);
  written += 1;
}

// A figure this run no longer produces has to go, or a refinement only ever adds. Tightening the
// language rules stopped emitting a NOCO charger's capacity in two languages and both stayed on
// disk anyway, because writing is not the same as replacing.
let stale = 0;
if (!dryRun) {
  const mine = new Set(
    records.models.filter((m) => m.manufacturer === manufacturer).map((m) => m.id),
  );
  const produced = new Set(collected.keys());
  for (const spec of records.specs) {
    if (!mine.has(spec.model) || produced.has(spec.id)) continue;
    // Only what this run is responsible for: a figure a person reviewed is not a run's to delete,
    // and one read by a different reader belongs to whichever run produced it.
    if (spec.reviewedBy || !spec.extractedBy) continue;
    rmSync(join(RECORDS_DIR, "specs", `${spec.id}.json`), { force: true });
    stale += 1;
  }
}

console.log(
  `${written} figures and ${modelsAdded} new models${dryRun ? " (dry run, nothing written)" : " written"} for ${manufacturer}`,
);
if (stale) console.log(`  ${stale} figures removed, which this run no longer produces`);

// A document whose last figure just went is cited by nothing, and the validator refuses an orphan.
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
if (orphans)
  console.log(`  ${orphans} source documents removed, cited by nothing once their figures went`);
for (const { url, language } of dropped)
  console.log(
    `  skipped the ${language} edition, which this maker also publishes in English: ${url.split("/").pop()}`,
  );
for (const reading of byLanguage.dropped)
  console.log(
    `  skipped a translated edition its file name did not declare: ${reading.url.split("/").pop()}`,
  );
if (repeatedTotal)
  console.log(
    `  ${repeatedTotal} figures dropped where a multilingual document stated them again in another language`,
  );
if (aligned.dropped.length)
  console.log(
    `  ${aligned.dropped.length} figures dropped: named in another language on a model that already has English figures`,
  );
if (aligned.kept.length) {
  console.log(
    `  ${aligned.kept.length} figures kept with a name nobody has translated, because their model has no English figure at all:`,
  );
  for (const spec of [...new Set(aligned.kept.map((s) => s.name))].slice(0, 10))
    console.log(`      ${spec}`);
}
const byReader = new Map<string, number>();
for (const r of readings.readings)
  byReader.set(
    r.extractedBy ?? EXTRACTOR_ID,
    (byReader.get(r.extractedBy ?? EXTRACTOR_ID) ?? 0) + 1,
  );
console.log(
  `${readings.readings.length} readings${pending > 0 ? `, ${pending} approved documents still converting or queued` : ""}`,
);
for (const [reader, n] of byReader) console.log(`  ${n} by ${reader}`);
for (const r of refused) console.log(`  not drawn, ${r.refused}: ${r.url.split("/").pop()}`);
if (withheld.length) {
  console.log(
    `\n${withheld.length} documents withheld from ${manufacturer}, a retailer, for a person to look at:`,
  );
  for (const w of withheld)
    console.log(`  ${w.url} (${w.sha256.slice(0, 12)}, ${w.products} products): ${w.reason}`);
}
if (unmatched.size) {
  console.log(`\n${unmatched.size} products the documents name that still reach no model:`);
  for (const m of [...unmatched].sort().slice(0, 25)) console.log(`  ${m}`);
}
if (rejected.size) {
  console.log(`\n${rejected.size} product names too sentence-like to hold as models:`);
  for (const m of [...rejected].sort().slice(0, 10)) console.log(`  ${m}`);
}

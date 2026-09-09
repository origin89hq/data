import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { Guess } from "../../schema/guess.ts";
import { object } from "./archive.ts";
import { classifierKey } from "../../scraper/src/classify.ts";

/**
 * Fold the classifier's answers back onto the models. A kind is the only field taken: the model
 * numbers and makers it also proposes were derived from the record itself and would be circular.
 *
 * Usage: pull-kinds.ts [--remote]
 */
const remote = process.argv.includes("--remote");
const prefix = `guesses/models/pending/${classifierKey()}`;
const manifest = object(`${prefix}/manifest.json`, remote);
if (!manifest) {
  console.error(`no classification at ${prefix}; push the models and run the classify workflow first`);
  process.exit(1);
}
const summary = JSON.parse(manifest) as { guesses: number; unanswered: number };
const source = object("sightings/models/pending/manifest.json", remote);
const pages = source ? (JSON.parse(source) as { pages: { page: number }[] }).pages.map((p) => p.page) : [];

const records = loadRecords();
const byId = new Map(records.models.map((m) => [m.id, m]));
let applied = 0;
let unknown = 0;
let skipped = 0;
for (const page of pages) {
  const body = object(`${prefix}/page-${String(page).padStart(4, "0")}.jsonl`, remote) ?? "";
  for (const line of body.split("\n").filter(Boolean)) {
    const guess = Guess.parse(JSON.parse(line));
    const model = byId.get(guess.productId);
    if (!model) continue;
    // A reviewed model's kind was somebody's decision; a classifier does not overwrite it.
    if (model.reviewedBy) { skipped += 1; continue; }
    if (guess.unreadable) { unknown += 1; continue; }
    writeRecord(RECORDS_DIR, "models", model.id, { ...model, kind: guess.kind });
    applied += 1;
  }
}
console.log(`classifier answered ${summary.guesses}, left ${summary.unanswered} unanswered`);
console.log(`${applied} kinds applied, ${unknown} unreadable and left absent, ${skipped} left alone because a person had reviewed them`);

import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { Guess } from "../../schema/guess.ts";
import { keysUnder, object, under } from "./archive.ts";
import { classifierKey } from "../../worker/src/classify.ts";

/**
 * Fold the classifier's answers back onto the models. A kind is the only field taken: the model
 * numbers and makers it also proposes were derived from the record itself and would be circular.
 *
 * Usage: pull-kinds.ts [--remote]
 */
const remote = process.argv.includes("--remote");
const prefix = `guesses/models/runs/pending/${classifierKey()}`;
const manifest = await object(`${prefix}/manifest.json`, remote);
if (!manifest) {
  console.error(`no classification at ${prefix}; push the models and run the classify workflow first`);
  process.exit(1);
}
const summary = JSON.parse(manifest) as { parts: number; sightings: number };
const written = new Set((await keysUnder(`${prefix}/page-`, remote)).map((k) => k.split("/").pop()));
const pending = Array.from({ length: summary.parts }, (_, i) => i + 1).filter((p) => !written.has(`page-${String(p).padStart(4, "0")}.jsonl`)).length;

const records = loadRecords();
const byId = new Map(records.models.map((m) => [m.id, m]));
let applied = 0;
let unknown = 0;
let cleared = 0;
let changed = 0;
let skipped = 0;
for (const line of (await under(`${prefix}/page-`, remote)).split("\n").filter(Boolean)) {
  const guess = Guess.parse(JSON.parse(line));
  const model = byId.get(guess.productId);
  if (!model) continue;
  // A reviewed model's kind was somebody's decision; a classifier does not overwrite it.
  if (model.reviewedBy) { skipped += 1; continue; }
  if (guess.unreadable) {
    unknown += 1;
    // A decline has to be able to take a kind away, or a re-run can only ever add. The classifier
    // could not decline at all until it was given the option, so a model it now refuses to judge
    // is still carrying whatever the old prompt guessed at it.
    if (model.kind) {
      const { kind, ...rest } = model;
      writeRecord(RECORDS_DIR, "models", model.id, rest);
      cleared += 1;
    }
    continue;
  }
  if (model.kind === guess.kind) continue;
  if (model.kind) changed += 1;
  writeRecord(RECORDS_DIR, "models", model.id, { ...model, kind: guess.kind });
  applied += 1;
}
console.log(`${summary.parts - pending} of ${summary.parts} parts written${pending ? `, ${pending} still on the queue or dead-lettered` : ""}`);
console.log(`${applied} kinds applied${changed ? `, ${changed} of them replacing a different answer` : ""}, ${unknown} unreadable, ${skipped} left alone because a person had reviewed them`);
if (cleared) console.log(`${cleared} kinds removed: the classifier declined a model an earlier prompt had guessed at`);

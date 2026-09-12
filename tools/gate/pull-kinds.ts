import { Guess } from "@origin89/equipment-schema/guess";
import { classifierKey } from "@origin89/equipment-schema/provenance";
import { withoutChemistry } from "../../src/chemistry.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";
import { keysUnder, object, under } from "./archive.ts";

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
  console.error(
    `no classification at ${prefix}; push the models and run the classify workflow first`,
  );
  process.exit(1);
}
const summary = JSON.parse(manifest) as { parts: number; sightings: number };
const written = new Set(
  (await keysUnder(`${prefix}/page-`, remote)).map((k) => k.split("/").pop()),
);
const pending = Array.from({ length: summary.parts }, (_, i) => i + 1).filter(
  (p) => !written.has(`page-${String(p).padStart(4, "0")}.jsonl`),
).length;

const records = loadRecords();
const byId = new Map(records.models.map((m) => [m.id, m]));
let applied = 0;
let unknown = 0;
let cleared = 0;
let changed = 0;
let unevidenced = 0;
/**
 * Whether a name tells a reader anything about the product.
 *
 * A run of four letters, or a word of three standing on its own. Victron's "ADA010100100" and
 * "ARG080201000" begin with three letters and say nothing, which is how 521 of them came back
 * out-of-scope from a company that makes nothing but off-grid electrical equipment.
 */
const saysSomething = (name: string): boolean =>
  /[A-Za-z]{4}/.test(name) || /(^|\s)[A-Za-z]{3}(\s|$)/.test(name);

/** Models that carry a figure, which is evidence a classifier could actually read. */
const documented = new Set(records.specs.map((spec) => spec.model));
let skipped = 0;
for (const line of (await under(`${prefix}/page-`, remote)).split("\n").filter(Boolean)) {
  const guess = Guess.parse(JSON.parse(line));
  const model = byId.get(guess.productId);
  if (!model) continue;
  // A reviewed model's kind was somebody's decision; a classifier does not overwrite it.
  if (model.reviewedBy) {
    skipped += 1;
    continue;
  }
  if (guess.unreadable) {
    unknown += 1;
    // A decline has to be able to take a kind away, or a re-run can only ever add. The classifier
    // could not decline at all until it was given the option, so a model it now refuses to judge
    // is still carrying whatever the old prompt guessed at it.
    if (model.kind) {
      const { kind, ...rest } = withoutChemistry(model);
      writeRecord(RECORDS_DIR, "models", model.id, rest);
      cleared += 1;
    }
    continue;
  }
  // "out-of-scope" is a positive claim that somebody could see what the product is. Twice now the
  // prompt has been told so and twice the model has used it as "I cannot tell": 610 Victron models
  // came back out-of-scope, and Victron makes nothing that is not off-grid electrical equipment.
  //
  // A claim needs evidence, so the guard is on the answer rather than the question. A listing with
  // no figures whose name is a bare part number says nothing about what the product is, and the
  // honest reading of an answer given no evidence is that there was none.
  if (guess.kind === "out-of-scope" && !documented.has(model.id) && !saysSomething(model.name)) {
    unevidenced += 1;
    if (model.kind) {
      const { kind, ...rest } = withoutChemistry(model);
      writeRecord(RECORDS_DIR, "models", model.id, rest);
      cleared += 1;
    }
    continue;
  }
  if (model.kind === guess.kind) continue;
  if (model.kind) changed += 1;
  // Only a battery carries a chemistry; a model that stops being one loses it with the kind.
  const next = guess.kind === "battery" ? model : withoutChemistry(model);
  writeRecord(RECORDS_DIR, "models", model.id, { ...next, kind: guess.kind });
  applied += 1;
}
console.log(
  `${summary.parts - pending} of ${summary.parts} parts written${pending ? `, ${pending} still on the queue or dead-lettered` : ""}`,
);
console.log(
  `${applied} kinds applied${changed ? `, ${changed} of them replacing a different answer` : ""}, ${unknown} unreadable, ${skipped} left alone because a person had reviewed them`,
);
if (unevidenced)
  console.log(
    `${unevidenced} out-of-scope answers refused: a bare part number with no figures is no evidence for a claim about what a product is`,
  );
if (cleared)
  console.log(
    `${cleared} kinds removed: the classifier declined a model an earlier prompt had guessed at`,
  );

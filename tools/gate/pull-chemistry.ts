import { applyChemistry } from "../../src/chemistry.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";

/**
 * Set each battery's chemistry from its own records: a figure on its sheet that names it, or
 * the maker's name for it. A model that already has one keeps it unless `--replace` is given, so
 * a chemistry a person set by hand is not overwritten by a pattern. Run after `just kinds` and
 * `just specs`, since only a battery may carry a chemistry and a figure may have just arrived.
 *
 * Usage: pull-chemistry.ts [--replace] [--dry-run]
 */
const args = process.argv.slice(2);
const replace = args.includes("--replace");
const dryRun = args.includes("--dry-run");
const records = loadRecords();
const { set, kept, none } = applyChemistry(
  records.models,
  records.specs,
  (model) => {
    if (!dryRun) writeRecord(RECORDS_DIR, "models", model.id, model);
  },
  replace,
);
console.log(
  `${set} batteries given a chemistry, ${kept} kept theirs, ${none} state none${dryRun ? " (dry run, nothing written)" : ""}`,
);

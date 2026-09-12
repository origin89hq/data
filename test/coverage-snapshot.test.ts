import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadRecords } from "../src/records.ts";
import { coverageSnapshot, SNAPSHOT_PATH } from "../tools/mappings/snapshot-path.ts";

/**
 * The committed snapshot is what the mappings read today. A change to a mapping, a record or the
 * builder that moves a number has to move it here too, so the pull request's diff says what the
 * change did to coverage and a reviewer sees a lost value or a new conflict without rebuilding.
 */
test("the coverage snapshot matches what the mappings read from the records; run `just coverage-snapshot` when a change moves it", () => {
  const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const current = coverageSnapshot(loadRecords());
  assert.deepEqual(
    current,
    committed,
    "coverage moved: run `just coverage-snapshot`, read the diff, and commit it with the change",
  );
});

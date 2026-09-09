import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const crawl = readFileSync(new URL("../src/manufacturer-crawl.ts", import.meta.url), "utf8");

test("an attempt's id is not the run's day, since a day can hold two attempts", () => {
  // `maker-<id>-<date>` as an instance id meant a second crawl of a maker on the same day was
  // refused as a duplicate of the first, which is how a re-run became impossible.
  assert.doesNotMatch(index, /id: `maker-\$\{[a-zA-Z.]+\}-\$\{checkedAt\}`/, "an attempt is being named after the day");
  assert.match(index, /crypto\.randomUUID\(\)/, "each attempt needs an id of its own");
});

test("the run records which instance owns it, so approving needs no id", () => {
  assert.match(crawl, /instance\.json/, "nothing would say which instance is waiting");
  assert.match(index, /currentInstance\(env/, "approval must be able to find the waiting instance");
});

test("approval still refuses when no run is recorded, rather than guessing an id", () => {
  assert.match(index, /no run recorded for/);
});

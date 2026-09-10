import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRecords } from "../src/records.ts";
import { validate } from "../src/validate.ts";

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const base = loadRecords();

test("nothing in the records claims to have happened after today", () => {
  assert.deepEqual(
    validate(base).errors.filter((e) => e.includes("has not happened")),
    [],
  );
});

test("a source retrieved tomorrow is refused, because a run's label is not a date", () => {
  const records = {
    ...base,
    sources: [
      ...base.sources,
      { id: "future", url: "https://x.test/a.pdf", retrievedAt: tomorrow },
    ],
  };
  assert.match(validate(records).errors.join("\n"), /retrieved on .*which has not happened/);
});

test("a decision dated tomorrow is refused too, whichever record carries it", () => {
  const brand = base.brands.find((b) => b.checkedAt);
  assert.ok(brand, "there is at least one decided brand to test with");
  const records = {
    ...base,
    brands: [{ ...brand, id: "future-brand", brand: "Future", checkedAt: tomorrow }],
  };
  assert.match(validate(records).errors.join("\n"), /decided on .*which has not happened/);
});

test("today is fine, so the check does not merely refuse everything", () => {
  const records = {
    ...base,
    sources: [...base.sources, { id: "now", url: "https://x.test/b.pdf", retrievedAt: today }],
  };
  assert.deepEqual(
    validate(records).errors.filter((e) => e.includes("has not happened")),
    [],
  );
});

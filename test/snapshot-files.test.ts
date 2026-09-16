import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSnapshotPart,
  SnapshotPlan,
  snapshotPartName,
} from "@origin89/equipment-schema/releases";
import { snapshotParts } from "../src/snapshot-files.ts";

const ids = (...list: string[]) => list.map((id) => ({ id }));

test("a kind becomes JSON array parts in code-unit id order, split before a part would pass its byte budget", () => {
  // Each record is 10 bytes, so two make a part of 2 + 10 + 1 + 10 = 23 bytes.
  const records = ids("b", "a");
  assert.deepEqual(snapshotParts("models", records, 23), [
    { name: "records_models_0001.json", text: '[{"id":"a"},{"id":"b"}]', rows: 2 },
  ]);
  assert.deepEqual(snapshotParts("models", records, 22), [
    { name: "records_models_0001.json", text: '[{"id":"a"}]', rows: 1 },
    { name: "records_models_0002.json", text: '[{"id":"b"}]', rows: 1 },
  ]);
  // The order a Worker's `<` gives, which a locale-aware sort would not: "+" < "-" < "." < letters.
  const mixed = snapshotParts("specs", ids("b", "a.1", "a-2", "a", "a+"));
  assert.deepEqual(JSON.parse(mixed[0]?.text ?? "[]"), ids("a", "a+", "a-2", "a.1", "b"));
  const figure = { id: "x", value: "12", unit: undefined, page: 3 };
  assert.equal(
    snapshotParts("specs", [figure])[0]?.text,
    JSON.stringify([figure]),
    "a part is the bytes JSON.stringify gives its records, absent fields left out",
  );
});

test("a part holds at most its row budget, and a kind with no records has no part", () => {
  const parts = snapshotParts("brands", ids("a", "b", "c", "d", "e"), 1024, 2);
  assert.deepEqual(
    parts.map((p) => [p.name, p.rows]),
    [
      ["records_brands_0001.json", 2],
      ["records_brands_0002.json", 2],
      ["records_brands_0003.json", 1],
    ],
  );
  assert.deepEqual(snapshotParts("mappings", []), []);
});

test("a repeated id, a record past the budget alone, or too many parts refuse the build", () => {
  assert.throws(
    () => snapshotParts("models", ids("a", "b", "a")),
    /models: the snapshot repeats the id a/,
  );
  assert.equal(
    snapshotParts("models", ids("a"), 12).length,
    1,
    "a record exactly filling a part fits",
  );
  assert.throws(() => snapshotParts("models", ids("a"), 11), /a alone exceeds the 11 bytes/);
  const many = Array.from({ length: 65 }, (_, i) => ({ id: `r${String(i).padStart(2, "0")}` }));
  assert.equal(snapshotParts("specs", many.slice(0, 64), 1024, 1).length, 64);
  assert.throws(
    () => snapshotParts("specs", many, 1024, 1),
    /specs: 65 snapshot parts, over the 64 a comparison reads/,
  );
});

test("a snapshot part is named by its kind and number, and the plan refuses any other name", () => {
  assert.equal(snapshotPartName("specs", 12), "records_specs_0012.json");
  assert.equal(isSnapshotPart("records_specs_0001.json"), true);
  assert.equal(isSnapshotPart("records_specs.json"), false);
  assert.equal(isSnapshotPart("specs_0001.ndjson"), false);
  const plan = (parts: string[]) => ({ version: 1, kinds: { specs: { parts, rows: 1 } } });
  assert.equal(SnapshotPlan.safeParse(plan(["records_specs_0001.json"])).success, true);
  assert.equal(SnapshotPlan.safeParse(plan(["specs_0001.ndjson"])).success, false);
  assert.equal(
    SnapshotPlan.safeParse(
      plan(Array.from({ length: 65 }, (_, i) => snapshotPartName("specs", i + 1))),
    ).success,
    false,
  );
});

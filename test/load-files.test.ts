import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoadPart, LoadPlan, loadPartName } from "@origin89/equipment-schema/releases";
import { loadParts } from "../src/load-files.ts";
import type { Table } from "../src/tables.ts";

const table = (rows: Table["rows"]): Table => ({
  name: "specs",
  columns: [
    { name: "id", type: "VARCHAR" },
    { name: "value", type: "VARCHAR" },
    { name: "page", type: "INTEGER" },
    { name: "doubt", type: "VARCHAR" },
  ],
  rows,
});

test("a table becomes NDJSON parts of a bounded number of rows, in the table's order", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, value: String(i), page: i }));
  const parts = loadParts(table(rows), 2);
  assert.deepEqual(
    parts.map((p) => [p.name, p.rows]),
    [
      ["specs_0001.ndjson", 2],
      ["specs_0002.ndjson", 2],
      ["specs_0003.ndjson", 1],
    ],
  );
  assert.equal(
    parts[0]?.text,
    '{"id":"s0","value":"0","page":0}\n{"id":"s1","value":"1","page":1}\n',
  );
  assert.equal(parts[2]?.text, '{"id":"s4","value":"4","page":4}\n');
  assert.ok(parts.every((p) => isLoadPart(p.name)));
});

test("an absent field is left out of the line, and a table with no rows has no part", () => {
  const [part] = loadParts(table([{ id: "a", value: "1", page: undefined, doubt: undefined }]));
  assert.equal(part?.text, '{"id":"a","value":"1"}\n');
  assert.deepEqual(loadParts(table([])), []);
  assert.deepEqual(loadParts(table([{ id: "b", value: "x", page: 2 }]), 20_000).length, 1);
});

test("a part is named by its table and number, and the plan refuses any other name", () => {
  assert.equal(loadPartName("model_keys", 12), "model_keys_0012.ndjson");
  assert.equal(isLoadPart("models_0001.ndjson"), true);
  assert.equal(isLoadPart("models.ndjson"), false);
  assert.equal(isLoadPart("models_0001.json"), false);
  const plan = {
    version: 1,
    tables: { models: { parts: ["models_0001.ndjson"], rows: 3, key: "id" } },
  };
  assert.equal(LoadPlan.safeParse(plan).success, true);
  assert.equal(
    LoadPlan.safeParse({ version: 1, tables: { models: { parts: ["models.csv"], rows: 3 } } })
      .success,
    false,
  );
});

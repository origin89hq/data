import assert from "node:assert/strict";
import { test } from "node:test";
import { queryRow } from "../apps/site/src/query-row.ts";

test("equipment aggregate counts can be serialized as React row keys", () => {
  const row = { id: "rolls-s48-100lfp", figures: 76n, documents: 1n, protocols: 0n };
  assert.throws(() => JSON.stringify(row), /BigInt/);
  assert.equal(
    JSON.stringify(queryRow(row)),
    '{"id":"rolls-s48-100lfp","figures":"76","documents":"1","protocols":"0"}',
  );
  assert.equal(row.figures, 76n);
});

test("large and negative integers keep their exact values", () => {
  assert.deepEqual(queryRow({ maximum: 9223372036854775807n, minimum: -9223372036854775808n }), {
    maximum: "9223372036854775807",
    minimum: "-9223372036854775808",
  });
});

test("nested Arrow lists and structs do not leave BigInts in the rendered row", () => {
  assert.deepEqual(queryRow({ sources: [{ page: 19n }], counts: [0n, 1n] }), {
    sources: [{ page: "19" }],
    counts: ["0", "1"],
  });
});

test("missing values and ordinary scalar types keep their meaning", () => {
  const row = { value: 0, unit: "Ah", page: null, reviewed: false, note: "" };
  assert.deepEqual(queryRow(row), row);
  assert.deepEqual(queryRow({}), {});
});

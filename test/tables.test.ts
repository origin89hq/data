import assert from "node:assert/strict";
import { test } from "node:test";
import { Model, Spec } from "@origin89/equipment-schema/model";
import type { Feed, FeedModel } from "../src/feeds.ts";
import type { Records } from "../src/records.ts";
import { type Row, tables } from "../src/tables.ts";

const READER = "ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast@p2";

const records: Records = {
  families: [],
  dialects: [],
  sources: [],
  manufacturers: [],
  brands: [],
  models: [
    Model.parse({ id: "rolls--s-550", manufacturer: "rolls", name: "S-550" }),
    Model.parse({
      id: "rolls--s-600",
      manufacturer: "rolls",
      name: "S-600",
      reviewedBy: "ada",
      checkedAt: "2026-09-11",
    }),
  ],
  specs: [
    Spec.parse({
      id: "rolls--s-550--capacity",
      model: "rolls--s-550",
      name: "Rated capacity",
      value: "428",
      unit: "Ah",
      source: "rolls-s-550-sheet",
      page: 1,
      extractedBy: READER,
      confidence: "vendor-doc",
    }),
    Spec.parse({
      id: "rolls--s-600--capacity",
      model: "rolls--s-600",
      name: "Rated capacity",
      value: "445",
      unit: "Ah",
      source: "rolls-s-600-sheet",
      page: 1,
      extractedBy: READER,
      reviewedBy: "ada",
      checkedAt: "2026-09-11",
      confidence: "vendor-doc",
    }),
  ],
};

const feed: Feed = {
  id: "sam-cec",
  title: "SAM component libraries",
  publisher: "NREL",
  license: "BSD-3-Clause",
  retrievedAt: "2026-09-01",
  files: [],
};
const feedModel: FeedModel = {
  id: "sam--acme--i-3000",
  feed: "sam-cec",
  manufacturerName: "Acme",
  name: "I-3000",
  kind: "inverter",
  specs: [{ name: "Paco", value: "3000", unit: "W" }],
};

const rowsOf = (name: string): Row[] => {
  const table = tables(records, [{ feed, models: [feedModel] }]).find((t) => t.name === name);
  assert.ok(table, `a ${name} table`);
  return table.rows;
};

test("a record says it is one, and nothing claims a review the columns do not show (#45)", () => {
  const tiers = (name: string) => rowsOf(name).map((row) => [row.id, row.tier, row.reviewed_by]);
  assert.deepEqual(tiers("models"), [
    ["rolls--s-550", "record", undefined],
    ["rolls--s-600", "record", "ada"],
    ["sam--acme--i-3000", "feed", undefined],
  ]);
  assert.deepEqual(
    tiers("specs").map(([, tier, reviewedBy]) => [tier, reviewedBy]),
    [
      ["record", undefined],
      ["record", "ada"],
      ["feed", undefined],
    ],
    "a figure a person checked stays a record; `reviewed_by` is what says so",
  );
});

test("what read a figure travels with it, and a feed's figure names no reader", () => {
  assert.deepEqual(
    rowsOf("specs").map((row) => row.extracted_by),
    [READER, READER, undefined],
  );
});

test("no published row calls itself reviewed", () => {
  for (const name of ["models", "specs"])
    assert.ok(
      rowsOf(name).every((row) => row.tier === "record" || row.tier === "feed"),
      `${name} holds only records and feed rows`,
    );
});

test("the feeds table counts what the feeds it was given hold", () => {
  assert.deepEqual(rowsOf("feeds"), [
    {
      id: "sam-cec",
      title: "SAM component libraries",
      publisher: "NREL",
      license: "BSD-3-Clause",
      retrieved_at: "2026-09-01",
      models: 1,
      figures: 1,
    },
  ]);
});

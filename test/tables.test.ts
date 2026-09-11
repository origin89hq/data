import assert from "node:assert/strict";
import { test } from "node:test";
import { Model, Spec } from "@origin89/equipment-schema/model";
import type { Feed, FeedModel } from "../src/feeds.ts";
import type { Records } from "../src/records.ts";
import { duplicateIds, type Row, tables } from "../src/tables.ts";

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
  mappings: [],
};

const SHA = "a".repeat(64);
const feed: Feed = {
  id: "sam-cec",
  title: "SAM component libraries",
  publisher: "NREL",
  license: "BSD-3-Clause",
  repository: "https://github.com/NatLabRockies/SAM",
  commit: "6ef6c5b2e42b202cee73582ae8ac74e830fff495",
  retrievedAt: "2026-09-01",
  files: [{ name: "CEC Inverters.csv", sha256: SHA, kind: "inverter" }],
};
const feedModel: FeedModel = {
  id: "sam--acme--i-3000",
  feed: "sam-cec",
  source: "sam-cec-cec-inverters",
  manufacturerName: "Acme",
  name: "I-3000",
  kind: "inverter",
  specs: [{ name: "Paco", value: "3000", unit: "W", conditions: "at rated AC output" }],
};

const rowsOf = (name: string, models = [feedModel]): Row[] => {
  const table = tables(records, [{ feed, models }]).find((t) => t.name === name);
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

test("a feed figure cites the file it came from, and that file is a source with its hash (#81)", () => {
  const figure = rowsOf("specs").find((row) => row.tier === "feed");
  assert.equal(figure?.source_id, "sam-cec-cec-inverters");
  assert.equal(figure?.conditions, "at rated AC output", "a feed figure keeps its conditions");
  const sources = rowsOf("sources");
  assert.deepEqual(
    sources.find((row) => row.id === figure?.source_id),
    {
      id: "sam-cec-cec-inverters",
      url: `https://raw.githubusercontent.com/NatLabRockies/SAM/${feed.commit}/deploy/libraries/CEC%20Inverters.csv`,
      path: undefined,
      title: "SAM component libraries: CEC Inverters.csv",
      publisher: "NREL",
      revision: feed.commit,
      sha256: SHA,
      retrieved_at: "2026-09-01",
      redistributable: true,
    },
    "the source is the file at the pinned commit, under the licence kept beside it",
  );
  const ids = new Set(sources.map((row) => row.id));
  assert.ok(
    rowsOf("specs").every((row) => ids.has(String(row.source_id)) || row.tier === "record"),
    "every feed figure's source resolves",
  );
});

test("a table that repeats an id is named, and one that does not is clean (#81)", () => {
  const twice = [feedModel, { ...feedModel, specs: [{ name: "Paco", value: "3300", unit: "W" }] }];
  const models = tables(records, [{ feed, models: twice }]).find((t) => t.name === "models");
  const specs = tables(records, [{ feed, models: twice }]).find((t) => t.name === "specs");
  assert.ok(models && specs);
  assert.deepEqual(duplicateIds(models), ["sam--acme--i-3000"]);
  assert.deepEqual(duplicateIds(specs), ["sam--acme--i-3000--paco"]);
  for (const table of tables(records, [{ feed, models: [feedModel] }]))
    assert.deepEqual(duplicateIds(table), [], `${table.name} repeats no id`);
  assert.deepEqual(
    duplicateIds({
      name: "x",
      columns: [{ name: "a", type: "VARCHAR" }],
      rows: [{ a: "1" }, { a: "1" }],
    }),
    [],
    "a table without an id column has nothing to repeat",
  );
});

test("a feed figure's id does not move when a figure before it is missing or added", () => {
  const full = {
    ...feedModel,
    specs: [
      { name: "Pdco", value: "3100", unit: "W" },
      { name: "Paco", value: "3000", unit: "W" },
    ],
  };
  const short = {
    ...feedModel,
    id: "sam--acme--i-3001",
    specs: [{ name: "Paco", value: "3000", unit: "W" }],
  };
  const ids = rowsOf("specs", [full, short])
    .filter((row) => row.tier === "feed")
    .map((row) => row.id);
  assert.deepEqual(ids, [
    "sam--acme--i-3000--pdco",
    "sam--acme--i-3000--paco",
    "sam--acme--i-3001--paco",
  ]);
  // A model id at the feed's 150-character cap with the three coefficient names: nothing cuts
  // the name, so the figures stay three ids.
  const long = {
    ...feedModel,
    id: `sam-cec-${"x".repeat(142)}`,
    specs: [
      "Temperature coefficient of short-circuit current",
      "Temperature coefficient of open-circuit voltage",
      "Temperature coefficient of maximum power",
    ].map((name) => ({ name, value: "-0.3", unit: "%/K" })),
  };
  const longIds = rowsOf("specs", [long])
    .filter((row) => row.tier === "feed")
    .map((row) => String(row.id));
  assert.equal(new Set(longIds).size, 3);
  assert.ok(
    longIds.every(
      (id) => id.endsWith("-current") || id.endsWith("-voltage") || id.endsWith("-power"),
    ),
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

test("model_keys keys every name under every label the maker goes by, by the one rule (#83)", () => {
  const withBrand: Records = {
    ...records,
    manufacturers: [
      { id: "rolls", name: "Rolls Battery", domains: [] },
    ] as unknown as Records["manufacturers"],
    brands: [
      {
        id: "surrette",
        brand: "Surrette",
        decision: "manufacturer",
        manufacturer: "rolls",
        evidence: {
          sellers: ["shop"],
          listings: 1,
          inScope: 1,
          kinds: [],
          models: [],
          proposed: [],
          examples: [],
          seenAt: "2026-09-01",
        },
      },
    ] as unknown as Records["brands"],
    models: [
      Model.parse({ id: "rolls--s-550", manufacturer: "rolls", name: "S-550", aliases: ["S550"] }),
    ],
    specs: [],
  };
  const rows = tables(withBrand, [{ feed, models: [feedModel] }]).find(
    (t) => t.name === "model_keys",
  );
  assert.deepEqual(rows?.rows, [
    {
      model_id: "rolls--s-550",
      key: "rollsbatterys550",
      name_key: "s550",
      label: "Rolls Battery",
      via: "name",
    },
    {
      model_id: "rolls--s-550",
      key: "surrettes550",
      name_key: "s550",
      label: "Surrette",
      via: "name",
    },
    {
      model_id: "sam--acme--i-3000",
      key: "acmei3000",
      name_key: "i3000",
      label: "Acme",
      via: "name",
    },
  ]);
  // An alias that keys the same as the name is one row, not two; a maker held by id alone is
  // keyed by that id.
  const plain = tables(records, []).find((t) => t.name === "model_keys");
  assert.deepEqual(
    plain?.rows.map((r) => [r.model_id, r.key, r.via]),
    [
      ["rolls--s-550", "rollss550", "name"],
      ["rolls--s-600", "rollss600", "name"],
    ],
  );
});

test("a model–dialect link publishes how it was made, its confidence and its citations (#84)", () => {
  const linked: Records = {
    ...records,
    models: [
      Model.parse({
        id: "rolls--s-550",
        manufacturer: "rolls",
        name: "S-550",
        dialects: [
          {
            dialect: "rolls-none",
            evidence: {
              kind: "register-match",
              sources: [
                { source: "rolls-manual", citation: "p. 12" },
                { source: "rolls-map", citation: "table 3" },
              ],
            },
            confidence: "community-crosschecked",
            firmware: { min: "2.1" },
          },
        ],
      }),
    ],
    specs: [],
  };
  const of = (name: string) => tables(linked, []).find((t) => t.name === name)?.rows;
  assert.deepEqual(of("model_dialects"), [
    {
      model_id: "rolls--s-550",
      dialect_id: "rolls-none",
      evidence_kind: "register-match",
      confidence: "community-crosschecked",
      firmware_min: "2.1",
      firmware_max: undefined,
    },
  ]);
  assert.deepEqual(of("model_dialect_sources"), [
    {
      model_id: "rolls--s-550",
      dialect_id: "rolls-none",
      position: 0,
      source_id: "rolls-manual",
      citation: "p. 12",
    },
    {
      model_id: "rolls--s-550",
      dialect_id: "rolls-none",
      position: 1,
      source_id: "rolls-map",
      citation: "table 3",
    },
  ]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandKind, MetricKind } from "@origin89/equipment-schema/enums";
import { EquipmentKind } from "@origin89/equipment-schema/guess";
import { vocabulary } from "../src/vocabulary.ts";

test("the vocabulary is the schema's own lists, in the schema's order", () => {
  const v = vocabulary();
  assert.deepEqual(v.metrics, [...MetricKind.options]);
  assert.deepEqual(v.commands, [...CommandKind.options]);
  assert.deepEqual(v.kinds, [...EquipmentKind.options]);
  assert.ok(v.metrics.includes("pv-voltage"), "the name a firmware crosswalk targets");
  assert.deepEqual(v.rowTiers, ["record", "feed"]);
  assert.deepEqual(v.refuter, ["checked", "not-checked", "unrecorded"]);
  assert.deepEqual(v.brandDecisions, ["manufacturer", "out-of-scope", "unresolved"]);
  assert.deepEqual(v.propertyBasis, ["reviewed", "extracted", "feed"]);
  assert.deepEqual(v.propertyGapReasons, ["no-claim", "unparsed", "needs-conditions", "conflict"]);
  assert.deepEqual(v.propertyStatus, ["value", "conflict"]);
  assert.deepEqual(v.propertyScopes, ["per-input", "total"]);
  assert.deepEqual(v.dialectKindDirections, ["reports", "accepts"]);
  assert.deepEqual(v.modelKeyVia, ["name", "alias"]);
  assert.deepEqual(
    v.dialectModelTiers,
    ["A", "B", "C", "D"],
    "a dialect's model tier is the catalogue's priority, not where a row comes from",
  );
});

test("every word is a kebab-case identifier or a tier letter, and no list repeats one", () => {
  for (const [list, words] of Object.entries(vocabulary())) {
    assert.equal(new Set(words).size, words.length, `${list} repeats a word`);
    // The catalogue's tiers are the one list spelled in capitals, as the catalogue wrote them.
    const shape = list === "dialectModelTiers" ? /^[A-D]$/ : /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const word of words) assert.match(word, shape, `${list}: ${JSON.stringify(word)}`);
  }
});

test("the vocabulary carries no empty list, since a consumer pins it to join on", () => {
  for (const [list, words] of Object.entries(vocabulary()))
    assert.ok(words.length > 0, `${list} is empty`);
});

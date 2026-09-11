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
  assert.deepEqual(v.tiers, ["record", "feed"]);
});

test("every word is a kebab-case identifier, and no list repeats one", () => {
  for (const [list, words] of Object.entries(vocabulary())) {
    assert.equal(new Set(words).size, words.length, `${list} repeats a word`);
    for (const word of words)
      assert.match(word, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${list}: ${JSON.stringify(word)}`);
  }
});

test("the vocabulary carries no empty list, since a consumer pins it to join on", () => {
  for (const [list, words] of Object.entries(vocabulary()))
    assert.ok(words.length > 0, `${list} is empty`);
});

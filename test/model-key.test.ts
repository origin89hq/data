import assert from "node:assert/strict";
import { test } from "node:test";
import { KINDS } from "@origin89/equipment-api/contract";
import { keyPart, makerKey, modelKey, nameKey } from "@origin89/equipment-api/keys";
import { EquipmentKind } from "@origin89/equipment-schema/guess";

test("a key part is NFKC, lower case, with spaces and dashes gone and nothing else touched", () => {
  assert.equal(keyPart("SmartSolar MPPT 150/35"), "smartsolarmppt150/35");
  assert.equal(
    keyPart("ＭＰＰＴ-１５０"),
    "mppt150",
    "full-width letters and digits meet their plain forms",
  );
  assert.equal(keyPart("ﬁrst"), "first", "a ligature is its letters");
  assert.equal(keyPart("PS‑MPPT–40 — 12V"), "psmppt4012v", "every kind of dash and space goes");
  assert.equal(keyPart("4,210,052,841"), "4,210,052,841", "commas stay: they are not spaces");
  assert.equal(keyPart("Capacité"), "capacité", "accents stay under NFKC");
  assert.equal(keyPart("  "), "");
});

test("a model key is the maker's part then the name's, with the maker's own name off the front", () => {
  assert.equal(modelKey("EG4 Electronics", "6000XP"), "eg4electronics6000xp");
  assert.equal(modelKey("EG4 Electronics", "EG4 6000XP"), "eg4electronics6000xp");
  assert.equal(modelKey("EG4 Electronics", "EG4 Electronics 6000XP"), "eg4electronics6000xp");
  assert.equal(nameKey("EG4 Electronics", "EG4-6000XP"), "6000xp");
  assert.equal(
    modelKey("EPEver (Beijing Epsolar Technology)", "EPEVER XTRA4210N"),
    "epeverxtra4210n",
    "the parenthetical is not part of the maker's name",
  );
  assert.equal(makerKey("Victron Energy"), "victronenergy");
  assert.equal(modelKey("Victron", "SmartSolar MPPT 150/35"), "victronsmartsolarmppt150/35");
});

test("a prefix shorter than three characters, or the whole name, is left alone", () => {
  assert.equal(nameKey("S", "S-550"), "s550", "a one-letter maker does not eat the S of S-550");
  assert.equal(nameKey("EG4 Electronics", "EG4"), "eg4", "a name that is only the maker stays");
  assert.equal(
    modelKey("Solark", "Sol-Ark 12K"),
    "solark12k",
    "a dash inside the maker's name is nothing",
  );
  assert.equal(modelKey("", "X"), "x", "no maker is an empty part");
});

test("the contract's kinds are the schema's kinds, so a pinned copy cannot drift", () => {
  assert.deepEqual([...KINDS], EquipmentKind.options);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { repairMojibake } from "../src/text.ts";
import { englishName } from "../src/translations.ts";
import { looksTruncated } from "../src/units.ts";
import { looksForeign } from "../src/language.ts";
import { loadRecords } from "../src/records.ts";

const records = loadRecords();

test("a run of UTF-8 bytes read as Latin-1 is decoded back", () => {
  // What a Unique Appliances sheet actually produced: an en dash arriving as its three bytes.
  assert.equal(repairMojibake("Température prédéfinie â Comf"), "Température prédéfinie – Comf");
  assert.equal(repairMojibake("tension dâalimentation"), "tension d’alimentation");
});

test("a lone accented character is left alone, since one byte is not a sequence to decode", () => {
  assert.equal(repairMojibake("Capacité de batterie"), "Capacité de batterie");
  assert.equal(repairMojibake("Température de stockage"), "Température de stockage");
  assert.equal(repairMojibake("plain ascii 12 V"), "plain ascii 12 V");
});

test("a value that is a fragment of its own JSON is refused, and an inch mark is not", () => {
  assert.equal(looksTruncated("24 & 48”}]}, {"), true);
  assert.equal(looksTruncated("3,500 lb.',"), true);
  assert.equal(looksTruncated("China”,"), true);
  assert.equal(looksTruncated('1/2.7", CMOS 2.1 MP'), false);
  assert.equal(looksTruncated("-15˚ C à -6˚ C"), false);
  assert.equal(looksTruncated("12/24"), false);
});

test("no committed figure carries a fragment as its value or an undecoded accent in its name", () => {
  for (const spec of records.specs) {
    assert.equal(looksTruncated(spec.value), false, `${spec.id} = ${spec.value}`);
    assert.equal(repairMojibake(spec.name), spec.name, `${spec.id} has an undecoded name: ${spec.name}`);
  }
});

test("every figure a maker printed in another language carries the English name beside it", () => {
  // The printed name stays; this is the aligned name a consumer groups by. A figure named in
  // another language with no English beside it cannot be grouped with the same figure in English,
  // which is the whole point of publishing the table.
  const foreign = records.specs.filter((s) => looksForeign(s.name));
  const missing = [...new Set(foreign.filter((s) => !s.english && !englishName(s.name)).map((s) => s.name))];
  assert.deepEqual(missing, [], "these printed names have no English equivalent in src/translations.ts");
});

test("a model is never described only in a language nobody can group by", () => {
  // A multilingual manual states each figure several times. The redundant rows go, so what is left
  // must be either English or aligned to it, for every model that has any figure at all.
  const byModel = new Map<string, { english: number; aligned: number; stranded: number }>();
  for (const spec of records.specs) {
    const row = byModel.get(spec.model) ?? { english: 0, aligned: 0, stranded: 0 };
    if (!looksForeign(spec.name)) row.english += 1;
    else if (spec.english) row.aligned += 1;
    else row.stranded += 1;
    byModel.set(spec.model, row);
  }
  const stranded = [...byModel].filter(([, row]) => row.stranded > 0).map(([model]) => model);
  assert.deepEqual(stranded, []);
});

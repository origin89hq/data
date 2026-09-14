import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@origin89/equipment-schema/model";
import { Spec } from "@origin89/equipment-schema/model";
import {
  heldByPerson,
  keepHeld,
  matchModel,
  pullWrites,
  sameName,
  specId,
  specsFrom,
  splitUnit,
  staleFigures,
} from "../src/specs.ts";

const models: Model[] = [
  {
    id: "rolls-battery-s-550",
    manufacturer: "rolls-battery",
    name: "S-550",
    aliases: ["S550", "8 CS 27P"],
    dialects: [],
  },
  { id: "epever-xtra4210n", manufacturer: "epever", name: "XTRA4210N", aliases: [], dialects: [] },
];
const base = {
  models,
  source: "rolls-renewable-pdf",
  extractedBy: "ai:@cf/test@p1",
  confidence: "vendor-doc" as const,
};

test("a figure is attached only when the document's own name answers to a model we hold", () => {
  const { specs, unmatched } = specsFrom({
    ...base,
    manufacturer: "rolls-battery",
    reports: [
      {
        model: "S-550",
        specs: [{ name: "Rated capacity", value: "428", unit: "Ah", conditions: "20-hour rate" }],
      },
      { model: "S-999", specs: [{ name: "Rated capacity", value: "999", unit: "Ah" }] },
    ],
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].model, "rolls-battery-s-550");
  assert.deepEqual(unmatched, ["S-999"]);
  Spec.parse(specs[0]);
});

test("one capacity at two discharge rates is two rows, which is why specs are not columns", () => {
  const { specs } = specsFrom({
    ...base,
    manufacturer: "rolls-battery",
    reports: [
      {
        model: "S-550",
        specs: [
          { name: "Rated capacity", value: "428", unit: "Ah", conditions: "20-hour rate" },
          { name: "Rated capacity", value: "556", unit: "Ah", conditions: "100-hour rate" },
        ],
      },
    ],
  });
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((s) => s.value).sort(), ["428", "556"]);
  assert.notEqual(specs[0].id, specs[1].id);
});

test("the same figure under the same conditions is one row however often the document repeats it", () => {
  const { specs } = specsFrom({
    ...base,
    manufacturer: "rolls-battery",
    reports: [
      {
        model: "S-550",
        specs: [
          { name: "Rated capacity", value: "428", unit: "Ah", conditions: "20-hour rate" },
          { name: "Rated capacity", value: "428", unit: "Ah", conditions: "20-hour rate" },
        ],
      },
    ],
  });
  assert.equal(specs.length, 1);
});

test("a name matches through punctuation and case but never across a different maker", () => {
  assert.equal(sameName("S-550", "s 550"), true);
  assert.equal(sameName("PS-MPPT-40", "PS MPPT 40"), true);
  assert.equal(sameName("S-550", "S-551"), false);
  assert.equal(sameName("", "x"), false);
  assert.ok(matchModel(models, "rolls-battery", "s550"));
  assert.equal(
    matchModel(models, "epever", "S-550"),
    undefined,
    "a Rolls name must not reach an EPEver model",
  );
});

test("an alias reaches the model, since a document often prints the part number", () => {
  assert.equal(matchModel(models, "rolls-battery", "8 CS 27P")?.id, "rolls-battery-s-550");
});

test("a figure with no name or no value is dropped rather than stored empty", () => {
  const { specs } = specsFrom({
    ...base,
    manufacturer: "epever",
    reports: [
      {
        model: "XTRA4210N",
        specs: [
          { name: "", value: "40", unit: "A" },
          { name: "Rated current", value: "  " },
          { name: "Rated current", value: "40", unit: "A" },
        ],
      },
    ],
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, "Rated current");
});

test("every extracted figure names the model that read it, so nothing looks confirmed", () => {
  const { specs } = specsFrom({
    ...base,
    manufacturer: "epever",
    reports: [{ model: "XTRA4210N", specs: [{ name: "Rated current", value: "40", unit: "A" }] }],
  });
  assert.equal(specs[0].extractedBy, "ai:@cf/test@p1");
  assert.equal(specs[0].reviewedBy, undefined);
  assert.equal(specs[0].source, "rolls-renewable-pdf");
});

test("a unit trapped in the table header becomes the unit, and a qualifier is left where it is", () => {
  assert.deepEqual(splitUnit("Rated Capacity (Ah)", undefined), {
    name: "Rated Capacity",
    unit: "Ah",
  });
  assert.deepEqual(splitUnit("Nominal voltage (V)", undefined), {
    name: "Nominal voltage",
    unit: "V",
  });
  assert.deepEqual(splitUnit("Operating temperature (°C)", undefined), {
    name: "Operating temperature",
    unit: "°C",
  });
  assert.deepEqual(splitUnit("Dimensions (D*W*H)", undefined), { name: "Dimensions (D*W*H)" });
  assert.deepEqual(splitUnit("Capacity (at 25 degrees)", undefined), {
    name: "Capacity (at 25 degrees)",
  });
  assert.deepEqual(
    splitUnit("Rated Capacity (Ah)", "Ah"),
    { name: "Rated Capacity (Ah)", unit: "Ah" },
    "a stated unit is trusted and the name left alone",
  );
  assert.deepEqual(
    splitUnit("(Ah)", undefined),
    { name: "(Ah)" },
    "a name that is only a unit is not a figure name",
  );
});

test("the page travels with the figure, and is never borrowed from another product's row", () => {
  const { specs } = specsFrom({
    ...base,
    manufacturer: "rolls-battery",
    reports: [
      {
        model: "S-550",
        specs: [{ name: "Rated capacity", value: "428", unit: "Ah", conditions: "20h", page: 7 }],
      },
      {
        model: "8 CS 27P",
        specs: [{ name: "Rated capacity", value: "428", unit: "Ah", conditions: "100h" }],
      },
    ],
  });
  const with7 = specs.find((s) => s.conditions === "20h");
  const without = specs.find((s) => s.conditions === "100h");
  assert.equal(with7?.page, 7);
  assert.equal(
    without?.page,
    undefined,
    "a figure whose window carried no page cites none, rather than the other row's",
  );
});

test("ids are stable, so a second extraction rewrites a figure rather than piling up duplicates", () => {
  assert.equal(specId("m", "Rated capacity", "20-hour rate"), "m--rated-capacity-20-hour-rate");
  assert.notEqual(
    specId("m", "Rated capacity", "20-hour rate"),
    specId("m", "Rated capacity", "100-hour rate"),
  );
});

const figure = (over: Partial<Spec>): Spec => ({
  id: "rolls-battery-s-550--rated-capacity-20-hour-rate",
  model: "rolls-battery-s-550",
  name: "Rated capacity",
  value: "428",
  unit: "Ah",
  conditions: "20-hour rate",
  source: "doc-aaaa",
  page: 3,
  extractedBy: "ai:@cf/test@p1",
  confidence: "vendor-doc",
  ...over,
});

test("a figure nobody reviewed is the run's to rewrite, and a new one is written", () => {
  const read = figure({ value: "430", source: "doc-bbbb", page: 4 });
  const fresh = figure({
    id: "rolls-battery-s-550--weight",
    name: "Weight",
    value: "57",
    unit: "kg",
  });
  const { write, agreed, disagreements } = keepHeld([figure({})], [read, fresh]);
  assert.deepEqual(write, [read, fresh]);
  assert.equal(agreed, 0);
  assert.deepEqual(disagreements, []);
});

test("a reviewed figure read again the same way is left as it is, review and all", () => {
  const reviewed = figure({ reviewedBy: "david", checkedAt: "2026-09-01" });
  const { write, agreed, disagreements } = keepHeld([reviewed], [figure({})]);
  assert.deepEqual(write, [], "the pull does not write over the reviewed record");
  assert.equal(agreed, 1);
  assert.deepEqual(disagreements, []);
});

test("a reviewed figure read differently is kept, and the disagreement names both readings", () => {
  const corrected = figure({ value: "440", reviewedBy: "david", checkedAt: "2026-09-01" });
  const read = figure({ value: "428", source: "doc-cccc", page: 9 });
  const { write, agreed, disagreements } = keepHeld([corrected], [read]);
  assert.deepEqual(write, []);
  assert.equal(agreed, 0);
  assert.equal(disagreements.length, 1);
  assert.deepEqual(disagreements[0].fields, ["value"]);
  assert.equal(
    disagreements[0].held,
    corrected,
    "the correction stays, with its source and review",
  );
  assert.equal(
    disagreements[0].read,
    read,
    "the reading is reported with its own document and page",
  );
});

test("the same figure from another document agrees; the reviewed record keeps its own source", () => {
  const reviewed = figure({ reviewedBy: "david", checkedAt: "2026-09-01" });
  const elsewhere = figure({ source: "doc-dddd", page: 12 });
  const { write, agreed, disagreements } = keepHeld([reviewed], [elsewhere]);
  assert.deepEqual(write, []);
  assert.equal(agreed, 1);
  assert.deepEqual(disagreements, []);
});

test("every distinct reading of a held figure is compared, not only the document that won", () => {
  const reviewed = figure({ reviewedBy: "david", checkedAt: "2026-09-01" });
  const same = figure({ source: "doc-eeee" });
  const other = figure({ value: "450", source: "doc-ffff", page: 2 });
  const otherAgain = figure({ value: "450", source: "doc-gggg", page: 5 });
  const unitOff = figure({ unit: "Wh", source: "doc-hhhh" });
  const candidates = new Map([[reviewed.id, [other, same, otherAgain, unitOff]]]);
  const { agreed, disagreements } = keepHeld([reviewed], [unitOff], candidates);
  assert.equal(agreed, 0, "one agreeing document does not make the id agreed");
  assert.deepEqual(
    disagreements.map((d) => [d.read.source, d.fields]),
    [
      ["doc-ffff", ["value"]],
      ["doc-hhhh", ["unit"]],
    ],
    "a reading stated twice is reported once, and the agreeing one not at all",
  );
});

test("conditions or a name the id cannot tell apart are still compared as what they say", () => {
  const below = figure({
    id: "rolls-battery-s-550--rated-capacity-25-c",
    conditions: "≤25 °C",
    reviewedBy: "david",
    checkedAt: "2026-09-01",
  });
  assert.equal(specId(below.model, below.name, "≥25 °C"), below.id, "the id drops the sign");
  const above = figure({ id: below.id, conditions: "≥25 °C", source: "doc-iiii" });
  const { agreed, disagreements } = keepHeld([below], [above]);
  assert.equal(agreed, 0);
  assert.deepEqual(
    disagreements.map((d) => d.fields),
    [["conditions"]],
  );
  const cased = figure({
    name: "Rated  Capacity",
    conditions: "20-hour  rate",
    source: "doc-jjjj",
  });
  const same = keepHeld([figure({ reviewedBy: "david" })], [cased]);
  assert.equal(same.agreed, 1, "case and spacing do not make a different figure");
  assert.deepEqual(same.disagreements, []);
});

test("a held figure the translation rule would drop is still compared, and the rule still sees held ones", () => {
  const english = figure({ reviewedBy: "david", checkedAt: "2026-09-01" });
  const foreignId = "rolls-battery-s-550--capacit-nominale-r-gime-20-heures";
  const foreign = (over: Partial<Spec>) =>
    figure({
      id: foreignId,
      name: "Capacité nominale",
      conditions: "régime 20 heures",
      ...over,
    });
  // A person holds the French figure with a corrected value; the run reads it back as 428 beside
  // the English one, which makes it redundant under the translation rule.
  const heldFrench = foreign({ value: "440", reviewedBy: "david", checkedAt: "2026-09-02" });
  const readFrench = foreign({ source: "doc-kkkk", page: 4 });
  const result = pullWrites([english, heldFrench], [figure({}), readFrench]);
  assert.deepEqual(
    result.disagreements.map((d) => [d.id, d.fields]),
    [[foreignId, ["value"]]],
    "the dropped translation is compared with what the person holds",
  );
  assert.equal(result.agreed, 1);
  assert.deepEqual(result.write, [], "neither held figure is written");
  // The other way round: the person holds the English figure, and the run's French one is
  // redundant beside it, so it is dropped rather than written just because the English one is held.
  const other = pullWrites([english], [figure({}), readFrench]);
  assert.deepEqual(other.write, []);
  assert.equal(other.aligned.dropped.length, 1);
  assert.equal(other.agreed, 1);
});

test("a figure written by hand, with no reader named, is held like a reviewed one", () => {
  const byHand = figure({ extractedBy: undefined, source: "rolls-renewable-pdf" });
  const { write, agreed } = keepHeld([byHand], [figure({})]);
  assert.deepEqual(write, []);
  assert.equal(agreed, 1);
  assert.equal(heldByPerson(figure({})), false);
  assert.equal(heldByPerson(figure({ reviewedBy: "david" })), true);
});

test("a row a document repeats in another language is returned, not lost, so a held figure under its id can be compared", () => {
  const { specs, repeated, repeatedRows } = specsFrom({
    ...base,
    manufacturer: "rolls-battery",
    reports: [
      {
        model: "S-550",
        specs: [
          { name: "Rated capacity", value: "428", unit: "Ah" },
          { name: "Capacité nominale", value: "428", unit: "Ah" },
        ],
      },
    ],
  });
  assert.equal(specs.length, 1);
  assert.equal(repeated, 1);
  assert.deepEqual(
    repeatedRows.map((row) => row.name),
    ["Capacité nominale"],
  );
});

test("a held figure the run read only under a dropped row is still compared, and never written", () => {
  const frenchId = "rolls-battery-s-550--capacit-nominale";
  const heldFrench = figure({
    id: frenchId,
    name: "Capacité nominale",
    conditions: undefined,
    value: "440",
    reviewedBy: "david",
    checkedAt: "2026-09-02",
  });
  const droppedRow = figure({
    id: frenchId,
    name: "Capacité nominale",
    conditions: undefined,
    source: "doc-llll",
    page: 2,
  });
  const english = figure({ id: "rolls-battery-s-550--rated-capacity", conditions: undefined });
  const candidates = new Map([
    [english.id, [english]],
    [frenchId, [droppedRow]],
  ]);
  const result = pullWrites([heldFrench], [english], candidates);
  assert.deepEqual(result.write, [english]);
  assert.deepEqual(
    result.disagreements.map((d) => [d.id, d.fields, d.read.source]),
    [[frenchId, ["value"], "doc-llll"]],
  );
  const agreeing = pullWrites(
    [heldFrench],
    [english],
    new Map([[frenchId, [{ ...droppedRow, value: "440" }]]]),
  );
  assert.equal(agreeing.agreed, 1);
  assert.deepEqual(agreeing.disagreements, []);
});

test("a second row under an id already taken is kept aside, so a held figure under it is still compared", () => {
  const { specs, repeated, repeatedRows } = specsFrom({
    ...base,
    manufacturer: "rolls-battery",
    reports: [
      {
        model: "S-550",
        specs: [
          { name: "Rated capacity", value: "428", unit: "Ah", conditions: "≤25 °C" },
          { name: "Rated capacity", value: "400", unit: "Ah", conditions: "≥25 °C" },
        ],
      },
    ],
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].conditions, "≤25 °C", "the first row wins");
  assert.equal(repeated, 0, "not a translation");
  assert.deepEqual(
    repeatedRows.map((row) => [row.value, row.conditions]),
    [["400", "≥25 °C"]],
  );
});

const weight = (over: Partial<Spec>): Spec =>
  figure({
    id: "rolls-battery-s-550--weight",
    name: "Weight",
    value: "57",
    unit: "kg",
    conditions: undefined,
    ...over,
  });
const rollsRun = (reread: string[], produced: string[] = []) => ({
  models: new Set(["rolls-battery-s-550"]),
  produced: new Set(produced),
  reread: new Set(reread),
});

test("a pull removes a figure only when the document that gave it was read again and gave it no more", () => {
  const fromReread = figure({ source: "doc-aaaa" });
  const fromUnread = weight({ source: "doc-bbbb" });
  assert.deepEqual(
    staleFigures([fromReread, fromUnread], rollsRun(["doc-aaaa"])).map((spec) => spec.id),
    [fromReread.id],
  );
});

test("a run that read none of the documents the records cite removes nothing", () => {
  // Champion's 2026-09-11 run fetched twenty documents, none of the fifty-eight its figures came from.
  const cited = [figure({ source: "doc-aaaa" }), weight({ source: "doc-bbbb" })];
  assert.deepEqual(staleFigures(cited, rollsRun(["doc-cccc"])), []);
  assert.deepEqual(staleFigures(cited, rollsRun([])), [], "nor does a run with no whole reading");
});

test("a figure read again, held by a person, or on another maker's model is never stale", () => {
  const readAgain = figure({ source: "doc-aaaa" });
  const reviewed = weight({ source: "doc-aaaa", reviewedBy: "david", checkedAt: "2026-09-01" });
  const byHand = weight({
    id: "rolls-battery-s-550--length",
    source: "doc-aaaa",
    extractedBy: undefined,
  });
  const anothers = figure({
    id: "epever-xtra4210n--rated-capacity-20-hour-rate",
    model: "epever-xtra4210n",
    source: "doc-aaaa",
  });
  assert.deepEqual(
    staleFigures([readAgain, reviewed, byHand, anothers], rollsRun(["doc-aaaa"], [readAgain.id])),
    [],
  );
});

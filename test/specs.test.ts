import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@origin89/equipment-schema/model";
import { Spec } from "@origin89/equipment-schema/model";
import {
  heldByPerson,
  keepHeld,
  keepUnitsApart,
  matchModel,
  mintedWithFigures,
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

test("a held name reaches its model with a maker's name in front or what it is behind, and a variant does not (#150)", () => {
  const makers = ["Rolls Battery", "EPEver"];
  assert.equal(
    matchModel(models, "rolls-battery", "Rolls S-550", makers)?.id,
    "rolls-battery-s-550",
  );
  assert.equal(
    matchModel(models, "rolls-battery", "S-550 Battery", makers)?.id,
    "rolls-battery-s-550",
  );
  assert.equal(
    matchModel(models, "epever", "EPEver XTRA4210N Controller", makers)?.id,
    "epever-xtra4210n",
  );
  assert.equal(
    matchModel(models, "rolls-battery", "S-550 24V", makers),
    undefined,
    "a voltage behind the name is another product",
  );
  assert.equal(matchModel(models, "rolls-battery", "Rolls S-551", makers), undefined);
  assert.equal(
    matchModel(models, "rolls-battery", "Rolls S-550"),
    undefined,
    "without the makers' names nothing is taken off",
  );
  assert.equal(
    matchModel(models, "epever", "Rolls S-550", makers),
    undefined,
    "what is left still has to be this maker's",
  );
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

test("a figure whose symbol the reader garbled is refused and listed, and the printed symbol is kept", () => {
  const read = (value: string) =>
    specsFrom({
      ...base,
      manufacturer: "epever",
      reports: [{ model: "XTRA4210N", specs: [{ name: "Cycle life", value }] }],
    });
  const garbledRead = read("£8000 cycles");
  assert.deepEqual(garbledRead.specs, []);
  assert.deepEqual(garbledRead.garbled, ["Cycle life = £8000 cycles"]);
  assert.deepEqual(garbledRead.truncated, [], "a garbled value is not reported as a fragment");
  const printed = read("≥8000 cycles");
  assert.deepEqual(
    printed.specs.map((spec) => spec.value),
    ["≥8000 cycles"],
  );
  assert.deepEqual(printed.garbled, []);
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

const power = (over: Partial<Spec>): Spec =>
  figure({
    id: "victron-energy-12-2000-80--cont-output-power-at-25-c-77-f",
    model: "victron-energy-12-2000-80",
    name: "Cont. output power at 25 °C / 77 °F",
    value: "1600",
    unit: "W",
    conditions: undefined,
    source: "doc-aaaa",
    page: 56,
    ...over,
  });
const plainId = "victron-energy-12-2000-80--cont-output-power-at-25-c-77-f";
const vaId = `${plainId}-va`;

test("a name two documents print in two units is two figures, the later unit's under an id that names it", () => {
  const watts = power({});
  const voltAmps = power({ value: "2000", unit: "VA", source: "doc-bbbb", page: 62 });
  const { place, splits } = keepUnitsApart([], [watts, voltAmps]);
  const placed = [watts, voltAmps].map(place);
  assert.deepEqual(
    placed.map((spec) => [spec.id, spec.value, spec.unit, spec.source]),
    [
      [plainId, "1600", "W", "doc-aaaa"],
      [vaId, "2000", "VA", "doc-bbbb"],
    ],
  );
  for (const spec of placed) Spec.parse(spec);
  assert.deepEqual(splits, [{ id: plainId, unit: "W", splitId: vaId, splitUnit: "VA" }]);
  assert.deepEqual(
    pullWrites([], placed).write.map((spec) => spec.id),
    [plainId, vaId],
    "both are written",
  );
});

test("one name read twice in one unit is still one figure, and the later document's reading wins", () => {
  const earlier = power({});
  const later = power({ value: "1650", source: "doc-bbbb", page: 62 });
  const { place, splits } = keepUnitsApart([], [earlier, later]);
  const placed = [earlier, later].map(place);
  assert.deepEqual(placed, [earlier, later], "both keep the plain id, in the order they were read");
  assert.deepEqual(splits, []);
  // Folded by id in reading order, as the pull folds them.
  const folded = [...new Map(placed.map((spec) => [spec.id, spec])).values()];
  assert.deepEqual(pullWrites([], folded).write, [later]);
});

test("a figure with no unit splits nothing, on either side, since it could be in either unit", () => {
  const watts = power({});
  const bare = power({ value: "2000", unit: undefined, source: "doc-bbbb" });
  const alone = keepUnitsApart([], [watts, bare]);
  assert.deepEqual([watts, bare].map(alone.place), [watts, bare]);
  assert.deepEqual(alone.splits, []);

  const voltAmps = power({ value: "2000", unit: "VA", source: "doc-cccc" });
  const beside = keepUnitsApart([], [watts, bare, voltAmps]);
  assert.deepEqual(
    [watts, bare, voltAmps].map(beside.place).map((spec) => spec.id),
    [plainId, plainId, vaId],
    "the bare reading stays with the plain id while the two units part",
  );

  // Held with no unit, the record says nothing about which unit is its own: the first unit read is.
  const heldBare = keepUnitsApart([bare], [voltAmps, watts]);
  assert.deepEqual(
    [voltAmps, watts].map(heldBare.place).map((spec) => spec.id),
    [plainId, `${plainId}-w`],
  );
});

test("a figure a person holds under the plain id keeps it, and the reading in the other unit takes its own id", () => {
  const reviewed = power({ reviewedBy: "david", checkedAt: "2026-09-01" });
  // The VA brochure is read first, so it is the held figure's unit that decides, not the order.
  const voltAmps = power({ value: "2000", unit: "VA", source: "doc-bbbb", page: 62 });
  const watts = power({ source: "doc-cccc" });
  const { place, splits } = keepUnitsApart([reviewed], [voltAmps, watts]);
  const placed = [voltAmps, watts].map(place);
  assert.deepEqual(
    placed.map((spec) => spec.id),
    [vaId, plainId],
  );
  assert.deepEqual(splits, [{ id: plainId, unit: "W", splitId: vaId, splitUnit: "VA" }]);
  const pulled = pullWrites([reviewed], placed);
  assert.deepEqual(
    pulled.write.map((spec) => [spec.id, spec.value]),
    [[vaId, "2000"]],
    "the held figure is not written over",
  );
  assert.equal(pulled.agreed, 1);
  assert.deepEqual(
    pulled.disagreements,
    [],
    "the VA figure is written under its own id, not reported against the W one",
  );

  // Held in kW, the same quantity as W: the W reading is the held figure read again, and disagrees
  // with it, while the VA reading is another rating with its own id.
  const inKilowatts = power({ value: "1.6", unit: "kW", reviewedBy: "david" });
  const apart = keepUnitsApart([inKilowatts], [voltAmps, watts]);
  const placedApart = [voltAmps, watts].map(apart.place);
  assert.deepEqual(
    placedApart.map((spec) => spec.id),
    [vaId, plainId],
  );
  const againstKilowatts = pullWrites([inKilowatts], placedApart);
  assert.deepEqual(
    againstKilowatts.write.map((spec) => spec.id),
    [vaId],
  );
  assert.deepEqual(
    againstKilowatts.disagreements.map((d) => d.id),
    [plainId],
  );
});

test("a unit that already has its own id goes back to it when a run reads only that unit, and the other figure stays", () => {
  const watts = power({});
  const voltAmps = power({ id: vaId, value: "2000", unit: "VA", source: "doc-bbbb", page: 62 });
  const reread = power({ value: "2000", unit: "VA", source: "doc-bbbb", page: 62 });
  const { place, splits } = keepUnitsApart([watts, voltAmps], [reread]);
  assert.equal(place(reread).id, vaId);
  assert.deepEqual(splits, [], "the id is not new, so there is nothing to report");
  assert.deepEqual(
    staleFigures([watts, voltAmps], {
      models: new Set([watts.model]),
      produced: new Set([place(reread).id]),
      reread: new Set(["doc-bbbb"]),
    }),
    [],
    "the W brochure was not read again, and the VA figure was produced",
  );
});

test("a run that reads only the other quantity gives it its own id and leaves the held figure", () => {
  // The current run holds the Marine brochure's VA figure and not the brochure the W figure came from.
  const watts = power({});
  const voltAmps = power({ value: "2000", unit: "VA", source: "doc-bbbb", page: 62 });
  const { place, splits } = keepUnitsApart([watts], [voltAmps]);
  assert.equal(place(voltAmps).id, vaId);
  assert.deepEqual(splits, [{ id: plainId, unit: "W", splitId: vaId, splitUnit: "VA" }]);
  assert.deepEqual(
    staleFigures([watts], {
      models: new Set([watts.model]),
      produced: new Set([vaId]),
      reread: new Set(["doc-bbbb"]),
    }),
    [],
    "the W figure is not stale: its brochure was not read",
  );
});

test("the same quantity spelled or scaled another way is one figure, and a unit nobody can name splits nothing", () => {
  const watts = power({});
  for (const unit of ["Wp", "Watts", "kW"]) {
    const respelled = power({ value: unit === "kW" ? "1.6" : "1600", unit, source: "doc-bbbb" });
    const { place, splits } = keepUnitsApart([watts], [respelled]);
    assert.equal(place(respelled).id, plainId, unit);
    assert.deepEqual(splits, [], unit);
  }
  const unnamed = power({ value: "1600", unit: "furlongs", source: "doc-bbbb" });
  const withUnnamed = keepUnitsApart([], [watts, unnamed]);
  assert.deepEqual(
    [watts, unnamed].map(withUnnamed.place).map((spec) => spec.id),
    [plainId, plainId],
  );
  assert.deepEqual(withUnnamed.splits, []);
});

test("each quantity read gets an id of its own, named by its unit, the ones that are only a symbol included", () => {
  const readings = ["W", "VA", "%", "Ω", "m²", "m", "kW"].map((unit) =>
    power({ unit, value: "1" }),
  );
  const { place, splits } = keepUnitsApart([], readings);
  assert.deepEqual(
    readings.map(place).map((spec) => spec.id),
    [
      plainId,
      vaId,
      `${plainId}-percent`,
      `${plainId}-ohm`,
      `${plainId}-m2`,
      `${plainId}-m`,
      plainId,
    ],
    "kW measures what W does and shares its id",
  );
  for (const spec of readings.map(place)) Spec.parse(spec);
  assert.equal(splits.length, 5, "every quantity but the first read is reported");
});

test("readings of one quantity at two scales share one id when another quantity holds the plain id", () => {
  // The VA brochure's figure holds the plain id; one sheet prints the rating in W, another in kW.
  const heldVoltAmps = power({ value: "2000", unit: "VA", source: "doc-bbbb" });
  const watts = power({ value: "1600", unit: "W", source: "doc-cccc" });
  const kilowatts = power({ value: "1.6", unit: "kW", source: "doc-dddd" });
  const { place, splits } = keepUnitsApart([heldVoltAmps], [watts, kilowatts]);
  assert.deepEqual(
    [watts, kilowatts].map(place).map((spec) => spec.id),
    [`${plainId}-w`, `${plainId}-w`],
  );
  assert.deepEqual(splits, [{ id: plainId, unit: "VA", splitId: `${plainId}-w`, splitUnit: "W" }]);

  // Held under an id of its own in kW, a later reading in W goes back to that id.
  const heldKilowatts = power({ id: `${plainId}-kw`, value: "1.6", unit: "kW" });
  const again = keepUnitsApart([heldVoltAmps, heldKilowatts], [watts]);
  assert.equal(again.place(watts).id, `${plainId}-kw`);
  assert.deepEqual(again.splits, []);
});

test("a model a pull minted is written only when a figure it writes cites it (#165)", () => {
  const minted = (name: string) => ({
    id: `pulsetech-${name.toLowerCase()}`,
    manufacturer: "pulsetech",
    name,
    aliases: [],
    dialects: [],
  });
  const { kept, empty } = mintedWithFigures(
    [minted("SP-7"), minted("SP-100"), minted("890PT")],
    [{ model: "pulsetech-sp-7" }, { model: "pulsetech-sp-7" }, { model: "pulsetech-xc450" }],
  );
  assert.deepEqual(
    kept.map((m) => m.name),
    ["SP-7"],
  );
  assert.deepEqual(
    empty.map((m) => m.name),
    ["SP-100", "890PT"],
    "a name whose figures all went is not written, and a figure for a held model changes nothing",
  );
  assert.deepEqual(
    mintedWithFigures([minted("SP-7")], []),
    { kept: [], empty: [minted("SP-7")] },
    "with nothing written, nothing minted is kept",
  );
});

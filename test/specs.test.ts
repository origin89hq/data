import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@origin89/equipment-schema/model";
import { Spec } from "@origin89/equipment-schema/model";
import { matchModel, sameName, specId, specsFrom, splitUnit } from "../src/specs.ts";

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

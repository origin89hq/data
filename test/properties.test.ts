import assert from "node:assert/strict";
import { test } from "node:test";
import { EquipmentKind } from "@origin89/equipment-schema/guess";
import {
  PROPERTIES,
  PROPERTY_BY_KEY,
  Property,
  Reading,
} from "@origin89/equipment-schema/properties";
import { QUANTITY_OF, UNITS } from "../src/units.ts";

test("every property in the registry is well formed, and no key is taken twice", () => {
  const keys = PROPERTIES.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  for (const property of PROPERTIES) {
    Property.parse(property);
    assert.ok(PROPERTY_BY_KEY.get(property.key) === property);
  }
  assert.ok(PROPERTIES.length >= 20, "the first checks' keys are all there");
});

test("a property's unit measures its quantity, so the parser and the registry agree on what a number means", () => {
  for (const property of PROPERTIES) {
    assert.ok(
      (UNITS as readonly string[]).includes(property.unit),
      `${property.key}: ${property.unit}`,
    );
    assert.equal(
      QUANTITY_OF[property.unit],
      property.quantity,
      `${property.key}: ${property.unit} measures ${QUANTITY_OF[property.unit]}, not ${property.quantity}`,
    );
  }
});

test("a property that needs a condition never also merely accepts it, and its kinds and reading are known", () => {
  for (const property of PROPERTIES) {
    const both = property.needs.filter((c) => property.accepts.includes(c));
    assert.deepEqual(both, [], `${property.key} both needs and accepts ${both.join(", ")}`);
    for (const kind of property.kinds) EquipmentKind.parse(kind);
    if (property.limits) Reading.parse(property.limits);
  }
});

test("a limit names the reading it bounds, and a capacity names the rate it needs", () => {
  assert.equal(PROPERTY_BY_KEY.get("pv.voc.max")?.limits, "pv-voltage");
  assert.deepEqual(PROPERTY_BY_KEY.get("battery.capacity")?.needs, ["dischargeHours"]);
  assert.deepEqual(PROPERTY_BY_KEY.get("inverter.power.surge")?.needs, ["duration"]);
  assert.deepEqual(PROPERTY_BY_KEY.get("panel.voc.stc")?.needs, ["stc"]);
  assert.equal(PROPERTY_BY_KEY.get("pv.mppt.window")?.shape, "range");
  assert.equal(PROPERTY_BY_KEY.get("battery.voltage.nominal")?.shape, "set");
  // A charger's keys reach everything that charges from the mains, an inverter-charger among them.
  for (const key of [
    "charge.power.max",
    "charge.battery.capacity",
    "charge.battery.capacity.recommended",
    "charge.current.max",
  ])
    assert.ok(PROPERTY_BY_KEY.get(key)?.kinds.includes("inverter-charger"), key);
  // A maker's one recommended size and the range it is made for are two shapes, so two keys.
  assert.equal(PROPERTY_BY_KEY.get("charge.battery.capacity")?.shape, "range");
  assert.equal(PROPERTY_BY_KEY.get("charge.battery.capacity.recommended")?.shape, "scalar");
});

test("a malformed property is refused by the schema", () => {
  const good = PROPERTY_BY_KEY.get("pv.voc.max");
  assert.ok(good);
  assert.throws(() => Property.parse({ ...good, key: "PvVoc" }), /key/);
  assert.throws(() => Property.parse({ ...good, unit: "kV" }));
  assert.throws(() => Property.parse({ ...good, kinds: [] }));
  assert.throws(() => Property.parse({ ...good, limits: "wind-speed" }));
  assert.throws(() => Property.parse({ ...good, extra: true }));
});

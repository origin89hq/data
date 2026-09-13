import assert from "node:assert/strict";
import { test } from "node:test";
import { PROPERTY_BY_KEY } from "@origin89/equipment-schema/properties";
import {
  parseQuantity,
  printedQuantities,
  printedQuantity,
  type Read,
  readProperty,
} from "../src/quantities.ts";

const ok = (read: Read) => {
  assert.ok(read.ok, read.ok ? "" : read.reason);
  return read.parsed;
};
const refused = (read: Read) => {
  assert.ok(!read.ok, "expected the figure to be refused");
  return read.reason;
};

test("a limit printed as a number, with its unit in the field, in the text, or in words, is one figure", () => {
  const scalar = { shape: "scalar", value: 150, unit: "V" };
  assert.deepEqual(ok(parseQuantity("150", "V", "voltage")), scalar);
  assert.deepEqual(ok(parseQuantity("150V", undefined, "voltage")), scalar);
  assert.deepEqual(ok(parseQuantity("150 Volts dc", undefined, "voltage")), scalar);
  assert.deepEqual(ok(parseQuantity("150 Vdc maximum", undefined, "voltage")), scalar);
  assert.deepEqual(ok(parseQuantity("400 VCC", undefined, "voltage")), {
    ...scalar,
    value: 400,
  });
  assert.deepEqual(ok(parseQuantity("1,000", "V", "voltage")), { ...scalar, value: 1000 });
  assert.deepEqual(
    ok(parseQuantity("850V/850V/850V", undefined, "voltage")),
    { ...scalar, value: 850 },
    "three inputs with one limit each are one limit",
  );
});

test("a range keeps both ends, however the maker drew the dash", () => {
  const range = { shape: "range", min: 8, max: 72, unit: "V" };
  assert.deepEqual(ok(parseQuantity("8 - 72 Volts dc", undefined, "voltage")), range);
  assert.deepEqual(ok(parseQuantity("8–72V", undefined, "voltage")), range);
  assert.deepEqual(ok(parseQuantity("8~72", "V", "voltage")), range);
  assert.deepEqual(ok(parseQuantity("8 to 72 Vdc", undefined, "voltage")), range);
  assert.deepEqual(ok(parseQuantity("125～425Vdc", undefined, "voltage")), {
    ...range,
    min: 125,
    max: 425,
  });
  assert.deepEqual(
    ok(parseQuantity("80-500Vdc / 80-500Vdc", undefined, "voltage")),
    { ...range, min: 80, max: 500 },
    "two inputs with the same window are one window",
  );
  assert.deepEqual(
    ok(parseQuantity('150" 850Vdc', undefined, "voltage")),
    { ...range, min: 150, max: 850 },
    "a dash a decoder turned into a quote is still a dash",
  );
  assert.match(refused(parseQuantity("80-500V / 100-500V", undefined, "voltage")), /differ/);
  assert.match(refused(parseQuantity("500-80", "V", "voltage")), /reversed/);
});

test("a range whose unit is printed at both ends is read once, and refused when the ends disagree", () => {
  assert.deepEqual(ok(parseQuantity("43 VDC to 59 VDC", undefined, "voltage")), {
    shape: "range",
    min: 43,
    max: 59,
    unit: "V",
  });
  assert.deepEqual(ok(parseQuantity("0A~140A", undefined, "current")), {
    shape: "range",
    min: 0,
    max: 140,
    unit: "A",
  });
  assert.deepEqual(ok(parseQuantity("-20°C to 60°C", undefined, "temperature")), {
    shape: "range",
    min: -20,
    max: 60,
    unit: "°C",
  });
  assert.deepEqual(
    ok(parseQuantity("16 V - 72 Volts dc", undefined, "voltage")),
    { shape: "range", min: 16, max: 72, unit: "V" },
    "the same unit spelt two ways is one unit",
  );
  assert.match(refused(parseQuantity("0A~140V", undefined, "current")), /two units/);
});

test("a number too long to be finite is not a figure, before or after its conversion", () => {
  const long = `1${"0".repeat(400)}`;
  assert.match(refused(parseQuantity(long, "V", "voltage")), /not a figure/);
  assert.match(refused(parseQuantity(`${long} - ${long}`, "V", "voltage")), /not a figure/);
  assert.match(refused(parseQuantity(`1 - ${long}`, "V", "voltage")), /not a figure/);
  const nearLimit = "9".repeat(306);
  assert.match(refused(parseQuantity(nearLimit, "kW", "power")), /too large to hold in W/);
  assert.match(refused(parseQuantity(`1 - ${nearLimit}`, "kW", "power")), /too large to hold in W/);
  assert.match(refused(parseQuantity(`1/${nearLimit}`, "kW", "power")), /too large to hold in W/);
});

test("a decimal comma with three places is a fraction when a lone zero stands before it, and a plus sign is a sign", () => {
  assert.deepEqual(ok(parseQuantity("0,046 %/°C", undefined, "temperature-coefficient")), {
    shape: "scalar",
    value: 0.046,
    unit: "%/K",
  });
  assert.deepEqual(ok(parseQuantity("-0,325", "%/K", "temperature-coefficient")), {
    shape: "scalar",
    value: -0.325,
    unit: "%/K",
  });
  assert.deepEqual(
    ok(parseQuantity("1,046", "W", "power")),
    { shape: "scalar", value: 1046, unit: "W" },
    "a thousand with a leading digit is still a thousand",
  );
  assert.deepEqual(ok(parseQuantity("+0.05% / °C", undefined, "temperature-coefficient")), {
    shape: "scalar",
    value: 0.05,
    unit: "%/K",
  });
  assert.deepEqual(ok(parseQuantity("+12 V", undefined, "voltage")), {
    shape: "scalar",
    value: 12,
    unit: "V",
  });
});

test("alternatives are a set, and a set of one is a figure", () => {
  assert.deepEqual(ok(parseQuantity("12/24/48V DC", undefined, "voltage")), {
    shape: "set",
    values: [12, 24, 48],
    unit: "V",
  });
  assert.deepEqual(ok(parseQuantity("12 / 24 V", undefined, "voltage")), {
    shape: "set",
    values: [12, 24],
    unit: "V",
  });
  assert.match(refused(parseQuantity("12-24 / 48V", undefined, "voltage")), /range beside/);
});

test("a coefficient reads per kelvin, and one in volts becomes a share of the figure it changes", () => {
  const coefficient = { shape: "scalar", value: -0.29, unit: "%/K" };
  assert.deepEqual(
    ok(parseQuantity("-0,29 %/°C", undefined, "temperature-coefficient")),
    coefficient,
  );
  assert.deepEqual(
    ok(parseQuantity("-0.29% / °C", undefined, "temperature-coefficient")),
    coefficient,
  );
  assert.deepEqual(ok(parseQuantity("-0.25", "%/K", "temperature-coefficient")), {
    ...coefficient,
    value: -0.25,
  });
  assert.deepEqual(
    ok(parseQuantity("-56 mV / °C", undefined, "temperature-coefficient", { reference: 20 })),
    { ...coefficient, value: -0.28 },
    "-56 mV/K of a 20 V figure is -0.28 %/K",
  );
  assert.deepEqual(
    ok(parseQuantity("-0.08 V/K", undefined, "temperature-coefficient", { reference: 40 })),
    { ...coefficient, value: -0.2 },
  );
  assert.match(
    refused(parseQuantity("-56 mV/°C", undefined, "temperature-coefficient")),
    /needs the figure/,
  );
});

test("a printed unit is converted to the canonical one, never dropped", () => {
  assert.deepEqual(ok(parseQuantity("16", "kW", "power")), {
    shape: "scalar",
    value: 16000,
    unit: "W",
  });
  assert.deepEqual(ok(parseQuantity("23.2", "kWh", "energy")), {
    shape: "scalar",
    value: 23200,
    unit: "Wh",
  });
  assert.deepEqual(ok(parseQuantity("120 mA", undefined, "current")), {
    shape: "scalar",
    value: 0.12,
    unit: "A",
  });
  assert.deepEqual(ok(parseQuantity("104", "°F", "temperature")), {
    shape: "scalar",
    value: 40,
    unit: "°C",
  });
  assert.deepEqual(ok(parseQuantity("2 min", undefined, "time")), {
    shape: "scalar",
    value: 120,
    unit: "s",
  });
});

test("a unit outside the quantity, a missing unit, or two units that disagree are refused, not guessed", () => {
  assert.match(refused(parseQuantity("428", "Ah", "voltage")), /Ah measures charge, not voltage/);
  assert.match(refused(parseQuantity("8.48", "kVA", "power")), /apparent-power, not power/);
  assert.match(refused(parseQuantity("1425", undefined, "charge")), /no unit/);
  assert.match(
    refused(parseQuantity("150V", "A", "voltage")),
    /printed in V but the unit field says A/,
  );
  assert.match(
    refused(parseQuantity("12V ± 0.1V", undefined, "voltage")),
    /not a unit|not a figure/,
  );
});

test("a bound, a sentence, and a word in the unit's place are not figures", () => {
  for (const bound of ["<16W", "≈ 20 watts", "less than 350 watts", "up to 150 V", "~ 20 W"])
    assert.match(
      refused(parseQuantity(bound, undefined, "power")),
      /bound or an approximation/,
      bound,
    );
  assert.match(
    refused(parseQuantity("70% of the designed capacity", undefined, "charge")),
    /not a unit/,
  );
  assert.match(
    refused(parseQuantity("(Battery voltage+2V)~ 72V", undefined, "voltage")),
    /not a figure/,
  );
  assert.match(
    refused(parseQuantity("EV_tempcomp (V/C)", undefined, "temperature-coefficient")),
    /not a figure/,
  );
  assert.match(refused(parseQuantity("", "V", "voltage")), /no value/);
  assert.match(
    refused(parseQuantity("92V(25℃)；95V(Lowest ambient temperature)", undefined, "voltage")),
    /not a unit/,
  );
});

test("an aside after the unit, a cut-off voltage, a bare decimal and a hyphenated unit are the maker's spelling, not a different figure", () => {
  // A charger's amps per bank, and a word in brackets: the unit stands before the aside.
  assert.deepEqual(parseQuantity("5A (12V)", undefined, "current"), {
    ok: true,
    parsed: { shape: "scalar", value: 5, unit: "A" },
  });
  assert.deepEqual(parseQuantity("2000mA (12V)", undefined, "current"), {
    ok: true,
    parsed: { shape: "scalar", value: 2, unit: "A" },
  });
  assert.deepEqual(parseQuantity("24A (Max)", undefined, "current"), {
    ok: true,
    parsed: { shape: "scalar", value: 24, unit: "A" },
  });
  // The same range in other units after it is not a second range.
  assert.deepEqual(parseQuantity("35 - 100°F (2 - 38°C)", undefined, "temperature"), {
    ok: true,
    parsed: { shape: "range", min: 1.666666667, max: 37.77777778, unit: "°C" },
  });
  // A unit that is only in the aside is still the unit.
  assert.deepEqual(parseQuantity("72 (W)", undefined, "power"), {
    ok: true,
    parsed: { shape: "scalar", value: 72, unit: "W" },
  });
  // A lead-acid capacity drawn down to a cell voltage: the voltage is a condition, not a range's end.
  assert.deepEqual(parseQuantity("155 A.H. to 1.70 VPC", undefined, "charge"), {
    ok: true,
    parsed: { shape: "scalar", value: 155, unit: "Ah" },
  });
  assert.deepEqual(parseQuantity("96 Ampere-Hours @ 1.75 V.P.C.", undefined, "charge"), {
    ok: true,
    parsed: { shape: "scalar", value: 96, unit: "Ah" },
  });
  assert.deepEqual(parseQuantity(".281KWH", undefined, "energy"), {
    ok: true,
    parsed: { shape: "scalar", value: 281, unit: "Wh" },
  });
  assert.deepEqual(parseQuantity("12-Volts", undefined, "voltage"), {
    ok: true,
    parsed: { shape: "scalar", value: 12, unit: "V" },
  });
  // A tolerance restates the figure; a second figure of the same kind changes it, and stays unread.
  assert.deepEqual(parseQuantity("13kW(±5%)", undefined, "power"), {
    ok: true,
    parsed: { shape: "scalar", value: 13000, unit: "W" },
  });
  assert.match(
    refused(parseQuantity("190A (software limited 185A)", undefined, "current")),
    /changes the figure/,
  );
  assert.match(
    refused(parseQuantity("2.25 gal (9.9 L)", undefined, "volume")),
    /changes the figure/,
  );
  // An absolute tolerance, a note with a number in it, and figures of other kinds all restate it.
  assert.deepEqual(parseQuantity("120 VAC (± 5 VAC)", undefined, "voltage"), {
    ok: true,
    parsed: { shape: "scalar", value: 120, unit: "V" },
  });
  assert.deepEqual(parseQuantity("400V (L1+L2+L3+N+PE)", undefined, "voltage"), {
    ok: true,
    parsed: { shape: "scalar", value: 400, unit: "V" },
  });
  // Words that say something the figure does not, a second figure of the same kind that nearly
  // agrees, a figure with a note around it, and a bounded time all change the figure.
  for (const changed of [
    "24A (per input)",
    "190A (188A)",
    "3600W (30A @ 230VAC)",
    "500 Watts (< 8 ms)",
    "120 VAC (nominal, L-N)",
  ])
    assert.match(
      refused(parseQuantity(changed, undefined, "power")),
      /changes the figure/,
      changed,
    );
  assert.deepEqual(parseQuantity("120 VAC (L-N)", undefined, "voltage"), {
    ok: true,
    parsed: { shape: "scalar", value: 120, unit: "V" },
  });
  // Alternatives that begin with a bare decimal split like any others.
  assert.deepEqual(parseQuantity(".5/.7A", undefined, "current"), {
    ok: true,
    parsed: { shape: "set", values: [0.5, 0.7], unit: "A" },
  });
  // Two banks' worth in one figure, and a second figure after a semicolon, are still not one figure.
  assert.match(refused(parseQuantity("5Ax2(12V)", undefined, "current")), /not a unit/);
  assert.match(
    refused(parseQuantity("92V(25℃)；95V(Lowest ambient temperature)", undefined, "voltage")),
    /not a unit/,
  );
});

const property = (key: string) => {
  const found = PROPERTY_BY_KEY.get(key);
  assert.ok(found, key);
  return found;
};

test("a property takes only its own shape, and a single figure fills a set", () => {
  assert.deepEqual(ok(readProperty("150 Volts dc", undefined, property("pv.voc.max"))), {
    shape: "scalar",
    value: 150,
    unit: "V",
  });
  assert.deepEqual(ok(readProperty("120~385 V", undefined, property("pv.mppt.window"))), {
    shape: "range",
    min: 120,
    max: 385,
    unit: "V",
  });
  assert.deepEqual(ok(readProperty("48", "V", property("battery.voltage.nominal"))), {
    shape: "set",
    values: [48],
    unit: "V",
  });
  assert.match(
    refused(readProperty("8 - 72 Volts dc", undefined, property("pv.voc.max"))),
    /a range where a scalar is needed/,
  );
  assert.match(
    refused(readProperty("500", "V", property("pv.mppt.window"))),
    /a scalar where a range is needed/,
  );
  assert.match(
    refused(readProperty("12/24/48V", undefined, property("pv.voc.max"))),
    /a set where a scalar is needed/,
  );
});

test("a property is read in its own unit: kilowatts become watts and a coefficient in volts needs its figure", () => {
  assert.deepEqual(ok(readProperty("16", "kW", property("inverter.power.surge"))), {
    shape: "scalar",
    value: 16000,
    unit: "W",
  });
  assert.match(refused(readProperty("428", "Ah", property("pv.voc.max"))), /charge, not voltage/);
  assert.deepEqual(
    ok(readProperty("-0.08 V/K", undefined, property("panel.voc.coefficient"), { reference: 40 })),
    { shape: "scalar", value: -0.2, unit: "%/K" },
  );
});

test("the quantity a figure is printed in is read from its unit, whatever the value's shape or wording", () => {
  assert.equal(printedQuantity("up to 500 VA", undefined), "apparent-power");
  assert.equal(printedQuantity("3000-4000", "VA"), "apparent-power");
  assert.equal(printedQuantity("16.97", "kVA"), "apparent-power");
  assert.equal(printedQuantity("450", "W"), "power");
  assert.equal(printedQuantity("1200 Watt at PF = 0.95", undefined), "power");
  assert.equal(printedQuantity("12.5", undefined), undefined);
});

test("a value printed in two quantities splits into a part for each, and a unit is read past an aside", () => {
  assert.deepEqual(printedQuantities("6KVA/6KW", undefined), [
    { quantity: "apparent-power", value: "6KVA" },
    { quantity: "power", value: "6KW" },
  ]);
  assert.deepEqual(printedQuantities("12/24/48V", undefined), [
    { quantity: "voltage", value: "12/24/48V" },
  ]);
  assert.deepEqual(printedQuantities("4000 VA (L-L)", undefined), [
    { quantity: "apparent-power", value: "4000 VA (L-L)" },
  ]);
  assert.deepEqual(printedQuantities("1200 Watt at PF = 0.95", undefined), [
    { quantity: "power", value: "1200 Watt at PF = 0.95" },
  ]);
  assert.deepEqual(printedQuantities("Pure sine wave", undefined), []);
  // A unit in the text outranks the unit field; the field covers only parts without one.
  assert.deepEqual(printedQuantities("6KVA/6KW", "VA"), [
    { quantity: "apparent-power", value: "6KVA" },
    { quantity: "power", value: "6KW" },
  ]);
  assert.deepEqual(printedQuantities("6000", "VA"), [
    { quantity: "apparent-power", value: "6000" },
  ]);
  assert.deepEqual(printedQuantities("6KVA/5KW/4KVA", undefined), [
    { quantity: "apparent-power", value: "6KVA" },
    { quantity: "power", value: "5KW" },
    { quantity: "apparent-power", value: "4KVA" },
  ]);
  // A unit in an annotation is not the figure's: the field decides, and without one nothing does.
  assert.deepEqual(printedQuantities("6000 @ 240 VAC", "VA"), [
    { quantity: "apparent-power", value: "6000 @ 240 VAC" },
  ]);
  assert.deepEqual(printedQuantities("6000 @ 240 VAC", undefined), []);
  // A bound stays on every part, so neither becomes an exact figure.
  assert.deepEqual(printedQuantities("up to 6KVA/6KW", undefined), [
    { quantity: "apparent-power", value: "up to 6KVA" },
    { quantity: "power", value: "up to 6KW" },
  ]);
});

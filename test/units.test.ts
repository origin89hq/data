import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalUnit,
  concerns,
  isNumeric,
  QUANTITY_OF,
  splitValueUnit,
  statesNothing,
} from "../src/units.ts";

test("a maker's own language reaches the same unit, since VCD and volts are volts", () => {
  assert.equal(canonicalUnit("V"), "V");
  assert.equal(canonicalUnit("VCD"), "V");
  assert.equal(canonicalUnit("VDC"), "V");
  assert.equal(canonicalUnit("pulgadas"), "in");
  assert.equal(canonicalUnit("libras"), "lb");
  assert.equal(canonicalUnit(" Ah "), "Ah");
  assert.equal(canonicalUnit("AMPS"), "A");
  // A module's watt-peak is its watt at standard test conditions.
  assert.equal(canonicalUnit("Wp"), "W");
});

test("a temperature coefficient per kelvin or per degree is one unit (#81)", () => {
  assert.equal(canonicalUnit("V/K"), "V/K");
  assert.equal(canonicalUnit("%/°C"), "%/K");
  assert.equal(canonicalUnit("A/ °C"), "A/K");
  assert.deepEqual(splitValueUnit("-0,29 %/°C", undefined), { value: "-0.29", unit: "%/K" });
  assert.deepEqual(splitValueUnit("-0.0709998", "V/K"), { value: "-0.0709998", unit: "V/K" });
  assert.deepEqual(concerns({ name: "Voc coefficient", value: "-0.324", unit: "%/K" }), []);
  assert.equal(
    canonicalUnit("W/K"),
    undefined,
    "a coefficient of a quantity nobody rates stays unknown",
  );
});

test("a word that ended up in the unit field is not a unit", () => {
  assert.equal(canonicalUnit("ACCEPTABLE"), undefined);
  assert.equal(canonicalUnit("STC"), undefined);
  assert.equal(canonicalUnit("DC"), undefined);
  assert.equal(canonicalUnit(""), undefined);
  assert.equal(canonicalUnit(undefined), undefined);
});

test("a figure is doubted when its unit is a word, or its value is not a number", () => {
  assert.deepEqual(concerns({ name: "Rated capacity", value: "428", unit: "Ah" }), []);
  assert.deepEqual(concerns({ name: "Battery type", value: "Flooded lead-acid" }), []);
  assert.match(concerns({ name: "x", value: "1", unit: "ACCEPTABLE" })[0], /not a unit/);
  assert.match(concerns({ name: "x", value: "> .95", unit: "A" })[0], /not a number/);
  assert.match(concerns({ name: "x", value: "1200" })[0], /no unit/);
});

test("a sentence is not a figure, which is what the first version of this missed", () => {
  assert.match(
    concerns({ name: "Charge voltage", value: "Default setting: 14.4V / 28.8V (adjustable)" })[0],
    /sentence/,
  );
  assert.match(
    concerns({
      name: "Interrupting capacity",
      value: "10,000 amperes at 160VDC and 65,000 amperes at 65VDC",
    })[0],
    /sentence/,
  );
  assert.deepEqual(concerns({ name: "Battery type", value: "Flooded lead-acid" }), []);
  assert.deepEqual(concerns({ name: "Automatic load disconnect", value: "Yes" }), []);
});

test("a count is legitimately a bare number, since cells are not measured in anything", () => {
  assert.deepEqual(concerns({ name: "Cells in series", value: "60" }), []);
  assert.deepEqual(concerns({ name: "Number of MPPT trackers", value: "2" }), []);
  assert.match(concerns({ name: "Continuous power", value: "1200" })[0], /no unit/);
});

test("a number is a number whichever way the maker writes the decimal", () => {
  assert.equal(isNumeric("428"), true);
  assert.equal(isNumeric("-0.5"), true);
  assert.equal(isNumeric("55,2"), true);
  assert.equal(isNumeric("-5.04E-05"), true, "the CEC library writes coefficients this way");
  assert.equal(isNumeric("1.01453e+06"), true);
  assert.equal(isNumeric("1e"), false);
  assert.equal(isNumeric("NaN"), false);
  assert.equal(isNumeric("12/24"), false);
  assert.equal(isNumeric("Yes"), false);
});

test("a unit glued to the value is pulled off, since the number and the unit are both already right", () => {
  assert.deepEqual(splitValueUnit("57.6V", undefined), { value: "57.6", unit: "V" });
  assert.deepEqual(splitValueUnit("400A", undefined), { value: "400", unit: "A" });
  assert.deepEqual(splitValueUnit("428", "Ah"), { value: "428", unit: "Ah" });
  assert.deepEqual(
    splitValueUnit("428", "pulgadas"),
    { value: "428", unit: "in" },
    "the stated unit still wins, in whatever language",
  );
  assert.deepEqual(
    splitValueUnit("-4 °F a 140 °F", undefined),
    { value: "-4 °F a 140 °F" },
    "a range is not a number with a unit",
  );
  assert.deepEqual(splitValueUnit("Yes", undefined), { value: "Yes" });
});

test("a European decimal comma becomes a point, and a thousands separator is left alone", () => {
  // An OutBack case height of "47,2 cm" read as a number is 472, so publishing the comma is a trap.
  assert.deepEqual(splitValueUnit("47,2", "cm"), { value: "47.2", unit: "cm" });
  assert.deepEqual(splitValueUnit("19,8", "kW"), { value: "19.8", unit: "kW" });
  // Three digits after the comma is a thousand, and Champion really does print "19,200 W".
  assert.deepEqual(splitValueUnit("19,200", "W"), { value: "19,200", unit: "W" });
  assert.deepEqual(splitValueUnit("3,500", "lb"), { value: "3,500", unit: "lb" });
  // Unless a lone zero stands before it: Peimar prints its Isc coefficient as "0,046 %/°C".
  assert.deepEqual(splitValueUnit("0,046 %/°C", undefined), { value: "0.046", unit: "%/K" });
  assert.deepEqual(splitValueUnit("-0,325", "%/K"), { value: "-0.325", unit: "%/K" });
});

test("a change per degree is a unit, per kelvin, so a coefficient keeps it and carries no doubt (#82)", () => {
  assert.equal(canonicalUnit("%/°C"), "%/K");
  assert.equal(canonicalUnit("% / °C"), "%/K");
  assert.equal(canonicalUnit("%/℃"), "%/K");
  assert.equal(canonicalUnit("mV/°C"), "mV/K");
  assert.equal(canonicalUnit("V/K"), "V/K");
  assert.deepEqual(splitValueUnit("-0,29 %/°C", undefined), { value: "-0.29", unit: "%/K" });
  assert.deepEqual(splitValueUnit("-56mV/°C", undefined), { value: "-56", unit: "mV/K" });
  assert.deepEqual(
    concerns({ name: "Temperature Coefficient of Voc", value: "-0.25", unit: "%/K" }),
    [],
  );
  assert.equal(QUANTITY_OF["%/K"], "temperature-coefficient");
  assert.equal(QUANTITY_OF.Ah, "charge");
});

test("a value that says there is no value is not a figure", () => {
  for (const empty of ["None", "no value given", "Not specified", "N/A", "---", "TBD"]) {
    assert.equal(statesNothing(empty), true, `${empty} should not be held as a figure`);
  }
  for (const real of ["12", "Yes", "0", "AGM", "12/24"]) {
    assert.equal(statesNothing(real), false, `${real} is a value`);
  }
});

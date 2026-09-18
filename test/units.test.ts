import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalUnit,
  concerns,
  isNumeric,
  QUANTITY_OF,
  splitValueUnit,
  statesNothing,
  withoutAnswerTail,
} from "../src/units.ts";

test("a value that kept the answer's next key is cut back to what the document prints (#188)", () => {
  assert.deepEqual(withoutAnswerTail("1000W', 'unit': "), { value: "1000W" });
  assert.deepEqual(withoutAnswerTail("31 lb, unit:"), { value: "31 lb" });
  assert.deepEqual(withoutAnswerTail("120/208V a.c.', 'unit': 'V"), {
    value: "120/208V a.c.",
    unit: "V",
  });
  assert.deepEqual(withoutAnswerTail("Pure Sine Wave', 'unit': "), { value: "Pure Sine Wave" });
  // The unit is the one the unit key names, wherever it sits among the keys that follow.
  assert.deepEqual(withoutAnswerTail("1000', 'unit': 'W', 'conditions': 'at 25 C"), {
    value: "1000",
    unit: "W",
  });
  assert.deepEqual(withoutAnswerTail("12.8', 'conditions': 'at 25 C', 'unit': 'V"), {
    value: "12.8",
    unit: "V",
  });
  assert.deepEqual(withoutAnswerTail("60 Hz', 'conditions': 'nominal"), { value: "60 Hz" });
  // A quote inside a later field's value does not hide the structure.
  assert.deepEqual(withoutAnswerTail("1000', 'unit': 'W', 'conditions': 'manufacturer's rating'"), {
    value: "1000",
    unit: "W",
  });
  assert.deepEqual(withoutAnswerTail("31 lb, unit: lb, conditions: manufacturer's rating"), {
    value: "31 lb",
    unit: "lb",
  });
  assert.deepEqual(
    withoutAnswerTail("20.70\" L x 3.34\" dia', '52.58 x 8.48 cm"),
    { value: '20.70" L x 3.34" dia' },
    "a list where one value belongs keeps the first",
  );
});

test("a value with no answer structure in it is left exactly as it is", () => {
  for (const value of ["95 - 135 VAC", "12/24", "3,500 lb", "1.0 GPM", "IP65 (with ports closed)"])
    assert.deepEqual(withoutAnswerTail(value), { value }, value);
  assert.deepEqual(
    withoutAnswerTail("', 'unit': "),
    { value: "', 'unit': " },
    "a value that is nothing but structure is left for the truncation check",
  );
});

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
  // A sheet that writes "51.2 V d.c." and "71 A d.c." means volts and amps.
  assert.equal(canonicalUnit("V d.c."), "V");
  assert.equal(canonicalUnit("V a.c."), "V");
  assert.equal(canonicalUnit("A d.c."), "A");
  assert.equal(canonicalUnit("A a.c."), "A");
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

test("a battery's C-rate is not degrees Celsius, whichever field the C arrived in", () => {
  // BSL's sheets state "Working Current 0.5C" and "Max Charging Current 1C": a rate against the
  // battery's own capacity. Read as a unit, half a degree was published as the working current.
  assert.deepEqual(splitValueUnit("0.5C", undefined, "Working Current"), { value: "0.5C" });
  assert.deepEqual(splitValueUnit("1C", undefined, "Max Charging Current"), { value: "1C" });
  assert.deepEqual(
    splitValueUnit("0.5", "C", "Charge working current"),
    { value: "0.5" },
    "a C that arrived in the unit field is no more a temperature than a glued one",
  );
  // The name is what makes a bare C a temperature, and a number no battery is rated at is one too.
  assert.deepEqual(splitValueUnit("45C", undefined, "Operating temperature"), {
    value: "45",
    unit: "°C",
  });
  assert.deepEqual(splitValueUnit("8C", undefined, "Ambient temperature"), {
    value: "8",
    unit: "°C",
  });
  assert.deepEqual(splitValueUnit("25C", undefined, "Internal resistance at 25C"), {
    value: "25",
    unit: "°C",
  });
  // Spelled out, it is a temperature wherever it stands.
  assert.deepEqual(splitValueUnit("0.5 °C", undefined, "Working Current"), {
    value: "0.5",
    unit: "°C",
  });
  assert.deepEqual(splitValueUnit("1", "Celsius", "Charging current"), { value: "1", unit: "°C" });
  assert.deepEqual(
    splitValueUnit("-0,29 %/°C", undefined, "Temperature coefficient of Voc"),
    { value: "-0.29", unit: "%/K" },
    "a coefficient per degree is untouched",
  );
});

test("a unit written in the value and in the unit field comes off the value once (#196)", () => {
  assert.deepEqual(splitValueUnit("100A", "A"), { value: "100", unit: "A" });
  assert.deepEqual(splitValueUnit("20 Amps", "A"), { value: "20", unit: "A" });
  assert.deepEqual(splitValueUnit("28.8±0.2V", "V"), { value: "28.8±0.2", unit: "V" });
  assert.deepEqual(splitValueUnit("About 5A", "A"), { value: "About 5", unit: "A" });
  assert.deepEqual(splitValueUnit("12-24-48V", "V"), { value: "12-24-48", unit: "V" });
  assert.deepEqual(splitValueUnit("34 –122°F", "°F"), { value: "34 –122", unit: "°F" });
  assert.deepEqual(splitValueUnit("47,2cm", "cm"), { value: "47.2", unit: "cm" });
  // What the unit field cannot say stays in the value: AC or DC, open circuit, a panel's peak.
  assert.deepEqual(splitValueUnit("120 VAC", "V"), { value: "120 VAC", unit: "V" });
  assert.deepEqual(splitValueUnit("12-24 VDC", "V"), { value: "12-24 VDC", unit: "V" });
  assert.deepEqual(splitValueUnit("525 Wp", "W"), { value: "525 Wp", unit: "W" });
  // A unit printed more than once, or beside another, is left where it is.
  assert.deepEqual(splitValueUnit("12 V / 24 V", "V"), { value: "12 V / 24 V", unit: "V" });
  assert.deepEqual(splitValueUnit("12.8V 100Ah", "Ah"), { value: "12.8V 100Ah", unit: "Ah" });
  assert.deepEqual(splitValueUnit("600V ac/dc", "V"), { value: "600V ac/dc", unit: "V" });
  // A number printed with a unit of the same quantity keeps it; another quantity's unit is no answer.
  assert.deepEqual(splitValueUnit("11mA", "A"), { value: "11", unit: "mA" });
  assert.deepEqual(splitValueUnit("+11mA", "A"), { value: "+11", unit: "mA" });
  assert.deepEqual(splitValueUnit("2.5 kW", "W"), { value: "2.5", unit: "kW" });
  assert.deepEqual(splitValueUnit("5Ah", "A"), { value: "5Ah", unit: "A" });
  // Another unit at the end, or no number before it, is not the unit repeated.
  assert.deepEqual(splitValueUnit("2560Wh", "V"), { value: "2560Wh", unit: "V" });
  assert.deepEqual(splitValueUnit("Pure Sine Wave", "V"), { value: "Pure Sine Wave", unit: "V" });
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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conditionsFrom,
  conditionsKey,
  mergeConditions,
  splitDuration,
} from "../src/conditions.ts";

test("a condition is read out of a figure's name only when its key accepts it", () => {
  assert.deepEqual(conditionsFrom("Max. PV Power 24Vdc", ["bankVoltage"]), { bankVoltage: 24 });
  assert.deepEqual(conditionsFrom("Max. PV Power 24Vdc", []), {}, "a key with no bank voltage");
  assert.deepEqual(
    conditionsFrom("Max. PV Power 500Vdc", ["bankVoltage"]),
    {},
    "500 V is no bank anybody sells",
  );
  assert.deepEqual(conditionsFrom("Open-circuit voltage at STC", ["stc"]), { stc: true });
  assert.deepEqual(conditionsFrom("Open-circuit voltage", ["stc"]), {});
});

test("a temperature is the cell's for a panel and the air's for everything else", () => {
  assert.deepEqual(conditionsFrom("Cont. output power at 25°C (77°F)", ["ambientTemperature"]), {
    ambientTemperature: 25,
  });
  assert.deepEqual(
    conditionsFrom("Cont. output power at 77°F", ["ambientTemperature"]),
    { ambientTemperature: 25 },
    "Fahrenheit alone is converted",
  );
  assert.deepEqual(
    conditionsFrom("Voc at 25 °C cell temperature", ["cellTemperature", "ambientTemperature"]),
    { cellTemperature: 25 },
  );
  assert.deepEqual(
    conditionsFrom("at 25°C", ["cellTemperature", "ambientTemperature"]),
    { ambientTemperature: 25 },
    "nothing says cell, so it is the air",
  );
  assert.deepEqual(conditionsFrom("Capacity at -20 °C", ["ambientTemperature"]), {
    ambientTemperature: -20,
  });
});

test("a discharge rate, a duration and a mode are read in the forms makers print them", () => {
  assert.deepEqual(conditionsFrom("Capacity at 10 Hour Rate", ["dischargeHours"]), {
    dischargeHours: 10,
  });
  assert.deepEqual(conditionsFrom("Rated capacity C20", ["dischargeHours"]), {
    dischargeHours: 20,
  });
  assert.deepEqual(conditionsFrom("Capacity, 100-hour rate", ["dischargeHours"]), {
    dischargeHours: 100,
  });
  assert.deepEqual(conditionsFrom("C-Rate", ["dischargeHours"]), {}, "a rate with no number");
  assert.deepEqual(conditionsFrom("30 sec Surge Power", ["duration"]), { duration: 30 });
  assert.deepEqual(conditionsFrom("5 min Surge Power", ["duration"]), { duration: 300 });
  assert.deepEqual(conditionsFrom("AC Overload Capability (100 ms surge)", ["duration"]), {
    duration: 0.1,
  });
  assert.deepEqual(conditionsFrom("1 msec surge current", ["duration"]), { duration: 0.001 });
  assert.deepEqual(conditionsFrom("Zero-load power in search mode", ["mode"]), { mode: "search" });
  assert.deepEqual(conditionsFrom("Idle Consumption - Invert mode, no load", ["mode"]), {
    mode: "invert",
  });
});

test("a fuel and a load share are read off a generator's words, each only when the key takes it", () => {
  assert.deepEqual(conditionsFrom("Watts (LPG) (Starting/Running)", ["fuel"]), { fuel: "lpg" });
  assert.deepEqual(conditionsFrom("Maximum continuous power, NG", ["fuel"]), {
    fuel: "natural-gas",
  });
  assert.deepEqual(conditionsFrom("Running watts, natural gas", ["fuel"]), {
    fuel: "natural-gas",
  });
  assert.deepEqual(conditionsFrom("Gasoline Capacity", ["fuel"]), { fuel: "gasoline" });
  assert.deepEqual(conditionsFrom("Propane run time", ["fuel"]), { fuel: "lpg" });
  assert.deepEqual(conditionsFrom("Watts (Starting/Running)", ["fuel"]), {}, "no fuel named");
  assert.deepEqual(conditionsFrom("Gasoline Capacity", []), {}, "a key with no fuel");
  assert.deepEqual(conditionsFrom("Run time at 50% load", ["load"]), { load: 50 });
  assert.deepEqual(conditionsFrom("Run time at 25 % rated load", ["load"]), { load: 25 });
  assert.deepEqual(conditionsFrom("Run time, full tank", ["load"]), {});
  // A pump's flow at a head, in feet or metres, only where the key keeps a head.
  assert.deepEqual(conditionsFrom("Capacity Gallons/Minute at 5 feet", ["head"]), { head: 1.524 });
  assert.deepEqual(conditionsFrom("GPM at 3 m of lift", ["head"]), { head: 3 });
  assert.deepEqual(conditionsFrom("Flow at 10 ft.", ["head"]), { head: 3.048 });
  assert.deepEqual(conditionsFrom("Capacity Gallons/Minute at 5 feet", []), {});
  assert.deepEqual(conditionsFrom("Flow rate", ["head"]), {});
});

test("a duration printed inside the value is split off it", () => {
  assert.deepEqual(splitDuration("145 A / 2 mins"), { value: "145 A", duration: 120 });
  assert.deepEqual(splitDuration("32A for 1s"), { value: "32A", duration: 1 });
  assert.deepEqual(splitDuration("3000 W @ 5 sec"), { value: "3000 W", duration: 5 });
  assert.deepEqual(splitDuration("150"), { value: "150" });
  assert.deepEqual(
    splitDuration("12/24/48V DC"),
    { value: "12/24/48V DC" },
    "a set is not a duration",
  );
});

test("a figure's own words win over its rule, and the same conditions key the same whatever the order", () => {
  assert.deepEqual(
    mergeConditions({ stc: true, bankVoltage: 12 }, { bankVoltage: 24 }, undefined),
    { stc: true, bankVoltage: 24 },
  );
  assert.equal(
    conditionsKey({ bankVoltage: 24, stc: true }),
    conditionsKey({ stc: true, bankVoltage: 24, mode: undefined }),
  );
  assert.notEqual(conditionsKey({ dischargeHours: 20 }), conditionsKey({ dischargeHours: 100 }));
  assert.equal(conditionsKey({}), "{}");
});

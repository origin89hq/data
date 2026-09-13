import assert from "node:assert/strict";
import { test } from "node:test";
import { Mapping } from "@origin89/equipment-schema/mapping";
import { Model, Spec } from "@origin89/equipment-schema/model";
import type { Feed, FeedModel } from "../src/feeds.ts";
import { buildProperties, type PropertiesInput } from "../src/properties.ts";

const READER = "ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast@p2";

const figure = (
  model: string,
  name: string,
  value: string,
  over: Partial<Spec> & { source?: string } = {},
): Spec =>
  Spec.parse({
    id: `${model}--${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${over.source ? `-${over.source}` : ""}`,
    model,
    name,
    value,
    source: "doc-a",
    page: 3,
    extractedBy: READER,
    confidence: "vendor-doc",
    ...over,
  });

const victron: Mapping = Mapping.parse({
  id: "victron-energy",
  version: 2,
  reviewedBy: "ada",
  checkedAt: "2026-09-11",
  rules: [
    { key: "pv.voc.max", names: ["Max. input voltage"], basis: "the sheet" },
    {
      key: "pv.power.max",
      names: ["Max. PV Power 12Vdc", "Max. PV Power 24Vdc"],
      basis: "the sheet",
    },
    { key: "charge.current.max", names: ["Rated charge current"], basis: "the sheet" },
    {
      key: "pv.mppt.window",
      names: ["MPPT voltage range"],
      unit: "V",
      basis: "the table header says V",
    },
  ],
});

const build = (over: Partial<PropertiesInput>) =>
  buildProperties({ models: [], specs: [], mappings: [], feeds: [], ...over });

const controller = Model.parse({
  id: "victron-energy-smartsolar-mppt100-20",
  manufacturer: "victron-energy",
  name: "SmartSolar MPPT 100/20",
  kind: "charge-controller",
});

test("a maker's figures reach the registry through its rules, with the bank voltage read off the name", () => {
  const { properties, gaps, coverage } = build({
    models: [controller],
    mappings: [victron],
    specs: [
      figure(controller.id, "Max. input voltage", "100", { unit: "V" }),
      figure(controller.id, "Max. PV Power 12Vdc", "290", { unit: "W" }),
      figure(controller.id, "Max. PV Power 24Vdc", "580", { unit: "W" }),
      figure(controller.id, "Rated charge current", "20", { unit: "A" }),
      figure(controller.id, "MPPT voltage range", "120-950"),
      figure(controller.id, "Weight", "1.45", { unit: "kg" }),
    ],
  });
  const voc = properties.find((p) => p.key === "pv.voc.max");
  assert.deepEqual(voc, {
    model: controller.id,
    key: "pv.voc.max",
    status: "value",
    value: 100,
    unit: "V",
    conditions: {},
    scope: "per-input",
    claim: `${controller.id}--max-input-voltage`,
    source: "doc-a",
    page: 3,
    mappedBy: "rule:victron-energy@2#1",
    basis: "extracted",
  });
  assert.deepEqual(
    properties.filter((p) => p.key === "pv.power.max").map((p) => [p.value, p.conditions]),
    [
      [290, { bankVoltage: 12 }],
      [580, { bankVoltage: 24 }],
    ],
    "one figure per bank voltage, each its own property",
  );
  assert.deepEqual(
    properties.find((p) => p.key === "pv.mppt.window"),
    {
      model: controller.id,
      key: "pv.mppt.window",
      status: "value",
      min: 120,
      max: 950,
      unit: "V",
      conditions: {},
      scope: "per-input",
      claim: `${controller.id}--mppt-voltage-range`,
      source: "doc-a",
      page: 3,
      mappedBy: "rule:victron-energy@2#4",
      basis: "extracted",
    },
    "a figure with no unit reads with the rule's",
  );
  assert.deepEqual(
    gaps.map((g) => [g.key, g.reason, g.claims]),
    [
      ["battery.voltage.nominal", "no-claim", 0],
      ["charge.battery.capacity", "no-claim", 0],
      ["charge.battery.capacity.recommended", "no-claim", 0],
      ["charge.power.max", "no-claim", 0],
      ["pv.isc.max", "no-claim", 0],
    ],
    "keys no rule reads are gaps with no claim, and a figure no rule names is not one",
  );
  assert.deepEqual(
    coverage.find((c) => c.key === "pv.voc.max"),
    {
      key: "pv.voc.max",
      kind: "charge-controller",
      models: 1,
      values: 1,
      partial: 0,
      conflicts: 0,
      noClaim: 0,
      unparsed: 0,
      needsConditions: 0,
    },
  );
  assert.equal(coverage.find((c) => c.key === "pv.isc.max")?.noClaim, 1);
});

test("a rule can require a condition the key only accepts, and a figure without it is a gap", () => {
  const perVoltage: Mapping = Mapping.parse({
    id: "victron-energy",
    version: 3,
    reviewedBy: "ada",
    checkedAt: "2026-09-11",
    rules: [
      {
        key: "pv.power.max",
        names: ["Recommended Maximum PV Array Input Power", "Max. PV Power 24Vdc"],
        requires: ["bankVoltage"],
        basis: "the sheet states it per system voltage",
      },
    ],
  });
  const { properties, gaps, coverage } = build({
    models: [controller],
    mappings: [perVoltage],
    specs: [
      figure(controller.id, "Recommended Maximum PV Array Input Power", "1100", { unit: "W" }),
    ],
  });
  assert.deepEqual(properties, []);
  assert.deepEqual(
    gaps.find((g) => g.key === "pv.power.max"),
    {
      model: controller.id,
      key: "pv.power.max",
      reason: "needs-conditions",
      detail: "no bankVoltage stated",
      claims: 1,
    },
  );
  assert.equal(coverage.find((c) => c.key === "pv.power.max")?.needsConditions, 1);
  const stated = build({
    models: [controller],
    mappings: [perVoltage],
    specs: [figure(controller.id, "Max. PV Power 24Vdc", "580", { unit: "W" })],
  });
  assert.deepEqual(
    stated.properties.map((p) => [p.value, p.conditions]),
    [[580, { bankVoltage: 24 }]],
    "the same rule reads a figure whose name carries the voltage",
  );
});

test("a figure that could not be read beside ones that could is still a gap, and the model is partial", () => {
  const phoenix: Mapping = Mapping.parse({
    id: "victron-energy",
    version: 3,
    reviewedBy: "ada",
    checkedAt: "2026-09-11",
    rules: [
      {
        key: "inverter.power.continuous",
        names: ["Cont. output power at 25°C", "Cont. output power at 40°C"],
        basis: "the sheet",
      },
    ],
  });
  const inverter = Model.parse({
    id: "victron-energy-phoenix-12-500",
    manufacturer: "victron-energy",
    name: "Phoenix 12/500",
    kind: "inverter",
  });
  const { properties, gaps, coverage } = build({
    models: [inverter],
    mappings: [phoenix],
    specs: [
      figure(inverter.id, "Cont. output power at 25°C", "up to 500", { unit: "W" }),
      figure(inverter.id, "Cont. output power at 40°C", "450", { unit: "W" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.value, p.conditions]),
    [[450, { ambientTemperature: 40 }]],
  );
  assert.deepEqual(
    gaps.find((g) => g.key === "inverter.power.continuous"),
    {
      model: inverter.id,
      key: "inverter.power.continuous",
      reason: "unparsed",
      detail: "a bound or an approximation, not a figure, beside 1 usable figure",
      claims: 2,
    },
  );
  const row = coverage.find((c) => c.key === "inverter.power.continuous");
  assert.deepEqual([row?.values, row?.partial, row?.unparsed], [1, 1, 0]);
});

const morningstar: Mapping = Mapping.parse({
  id: "morningstar",
  version: 1,
  reviewedBy: "ada",
  checkedAt: "2026-09-11",
  rules: [
    {
      key: "pv.voc.max",
      names: ["Maximum PV Open Circuit Voltage", "Maximum Solar Input Voltage"],
      basis: "the sheets",
    },
    { key: "charge.current.max", names: ["Maximum Battery Current"], basis: "the sheets" },
    { key: "pv.power.max", names: ["Max PV Input"], source: "doc-b", basis: "one sheet only" },
  ],
});
const tristar = Model.parse({
  id: "morningstar-ts-mppt-60",
  manufacturer: "morningstar",
  name: "TS-MPPT-60",
  kind: "charge-controller",
});

test("two documents that agree are one property, cited from the figure a person checked", () => {
  const { properties, gaps } = build({
    models: [tristar],
    mappings: [morningstar],
    specs: [
      figure(tristar.id, "Maximum PV Open Circuit Voltage", "150 volts DC"),
      figure(tristar.id, "Maximum Solar Input Voltage", "150 Volts dc", {
        source: "doc-b",
        reviewedBy: "ada",
        checkedAt: "2026-09-11",
      }),
    ],
  });
  const [voc, ...rest] = properties.filter((p) => p.key === "pv.voc.max");
  assert.deepEqual(rest, []);
  assert.equal(voc?.value, 150);
  assert.equal(voc?.status, "value");
  assert.equal(voc?.basis, "reviewed");
  assert.equal(voc?.claim, `${tristar.id}--maximum-solar-input-voltage-doc-b`);
  assert.ok(!gaps.some((g) => g.key === "pv.voc.max"));
});

test("two documents that disagree are a conflict: both publish, marked, and the key is a gap", () => {
  const { properties, gaps, coverage } = build({
    models: [tristar],
    mappings: [morningstar],
    specs: [
      figure(tristar.id, "Maximum PV Open Circuit Voltage", "150", { unit: "V" }),
      figure(tristar.id, "Maximum Solar Input Voltage", "200", { unit: "V", source: "doc-b" }),
    ],
  });
  assert.deepEqual(
    properties.filter((p) => p.key === "pv.voc.max").map((p) => [p.value, p.status]),
    [
      [150, "conflict"],
      [200, "conflict"],
    ],
  );
  assert.deepEqual(
    gaps.find((g) => g.key === "pv.voc.max"),
    {
      model: tristar.id,
      key: "pv.voc.max",
      reason: "conflict",
      detail: "1 set of conditions with figures that disagree",
      claims: 2,
    },
  );
  const row = coverage.find((c) => c.key === "pv.voc.max");
  assert.deepEqual([row?.values, row?.conflicts], [0, 1]);
});

test("a figure the parser refuses is a gap that says why, and a rule scoped to a document reads only it", () => {
  const { properties, gaps } = build({
    models: [tristar],
    mappings: [morningstar],
    specs: [
      figure(
        tristar.id,
        "Maximum Battery Current",
        "130% of the controller’s output current rating (approximate)",
      ),
      figure(tristar.id, "Max PV Input", "4200", { unit: "W" }),
    ],
  });
  assert.deepEqual(
    gaps.find((g) => g.key === "charge.current.max"),
    {
      model: tristar.id,
      key: "charge.current.max",
      reason: "unparsed",
      detail: '"%ofthecontroller’soutputcurrentrating" is not a unit',
      claims: 1,
    },
  );
  assert.ok(!properties.some((p) => p.key === "pv.power.max"));
  assert.deepEqual(
    gaps.find((g) => g.key === "pv.power.max"),
    { model: tristar.id, key: "pv.power.max", reason: "no-claim", claims: 0 },
    "the figure is from doc-a and the rule reads doc-b only",
  );
});

const rolls: Mapping = Mapping.parse({
  id: "rolls-battery",
  version: 1,
  reviewedBy: "ada",
  checkedAt: "2026-09-11",
  rules: [
    {
      key: "battery.capacity",
      names: ["Capacity", "Capacity at 20 Hour Rate", "Capacity at 100 Hour Rate"],
      basis: "the sheet",
    },
    { key: "battery.discharge.current.peak", names: ["Peak DSG Current"], basis: "the guide" },
  ],
});
const battery = Model.parse({
  id: "rolls-battery-s-550",
  manufacturer: "rolls-battery",
  name: "S-550",
  kind: "battery",
});

test("a capacity needs its rate: one without is a gap, and two rates are two properties", () => {
  const without = build({
    models: [battery],
    mappings: [rolls],
    specs: [figure(battery.id, "Capacity", "428", { unit: "Ah" })],
  });
  assert.deepEqual(
    without.gaps.find((g) => g.key === "battery.capacity"),
    {
      model: battery.id,
      key: "battery.capacity",
      reason: "needs-conditions",
      detail: "no dischargeHours stated, and no chemistry recorded that would waive it",
      claims: 1,
    },
  );
  assert.equal(without.coverage.find((c) => c.key === "battery.capacity")?.needsConditions, 1);

  const rated = build({
    models: [battery],
    mappings: [rolls],
    specs: [
      figure(battery.id, "Capacity at 20 Hour Rate", "428", { unit: "Ah" }),
      figure(battery.id, "Capacity at 100 Hour Rate", "556", { unit: "Ah" }),
    ],
  });
  assert.deepEqual(
    rated.properties
      .filter((p) => p.key === "battery.capacity")
      .map((p) => [p.value, p.conditions])
      .sort(([a], [b]) => Number(a) - Number(b)),
    [
      [428, { dischargeHours: 20 }],
      [556, { dischargeHours: 100 }],
    ],
  );
  assert.ok(!rated.gaps.some((g) => g.key === "battery.capacity"));
});

test("a duration printed in the value becomes the condition a peak figure needs", () => {
  const { properties } = build({
    models: [battery],
    mappings: [rolls],
    specs: [figure(battery.id, "Peak DSG Current", "145 A / 2 mins")],
  });
  const peak = properties.find((p) => p.key === "battery.discharge.current.peak");
  assert.deepEqual([peak?.value, peak?.unit, peak?.conditions], [145, "A", { duration: 120 }]);
});

const feed: Feed = {
  id: "sam-cec",
  title: "SAM",
  publisher: "NREL",
  license: "BSD-3-Clause",
  repository: "https://github.com/NatLabRockies/SAM",
  commit: "6ef6c5b2e42b202cee73582ae8ac74e830fff495",
  retrievedAt: "2026-09-01",
  files: [],
};
const panel: FeedModel = {
  id: "sam-cec-lumos-s32-190",
  feed: "sam-cec",
  source: "sam-cec-cec-modules",
  manufacturerName: "Lumos",
  name: "S32-190",
  kind: "panel",
  specs: [
    { name: "Nameplate power at standard test conditions", value: "190", conditions: "STC" },
    { name: "Open-circuit voltage", value: "21.9", unit: "V", conditions: "STC" },
    { name: "Short-circuit current", value: "11.2", unit: "A", conditions: "STC" },
    { name: "Temperature coefficient of open-circuit voltage", value: "-0.0709998", unit: "V/K" },
    { name: "Temperature coefficient of short-circuit current", value: "0.005", unit: "A/K" },
    { name: "Temperature coefficient of maximum power", value: "-0.35", unit: "%/K" },
    { name: "Cells in series", value: "32" },
  ],
};
const inverter: FeedModel = {
  id: "sam-cec-acme-i-3000",
  feed: "sam-cec",
  source: "sam-cec-cec-inverters",
  manufacturerName: "Acme",
  name: "I-3000",
  kind: "inverter",
  specs: [
    { name: "Maximum AC power output", value: "3000", unit: "W" },
    { name: "Maximum DC voltage", value: "600", unit: "V" },
    { name: "Lowest MPPT voltage", value: "100", unit: "V" },
    { name: "Highest MPPT voltage", value: "550", unit: "V" },
    { name: "Night tare loss", value: "0.5", unit: "W" },
    { name: "AC voltage", value: "240", unit: "V" },
  ],
};

test("a feed maps by column, at STC where the row says so, citing the file it came from", () => {
  const { properties, gaps } = build({
    feeds: [
      { feed, model: panel },
      { feed, model: inverter },
    ],
  });
  const voc = properties.find((p) => p.model === panel.id && p.key === "panel.voc.stc");
  assert.deepEqual(voc, {
    model: panel.id,
    key: "panel.voc.stc",
    status: "value",
    value: 21.9,
    unit: "V",
    conditions: { stc: true },
    claim: `${panel.id}--open-circuit-voltage`,
    source: "sam-cec-cec-modules",
    mappedBy: "feed:sam-cec/Open-circuit voltage@1",
    basis: "feed",
  });
  const power = properties.find((p) => p.model === panel.id && p.key === "panel.power.stc");
  assert.deepEqual(
    [power?.value, power?.unit, power?.conditions],
    [190, "W", { stc: true }],
    "the STC power column carries no unit in the file; the rule states watts from SAM's documentation",
  );
  assert.ok(!gaps.some((g) => g.model === panel.id && g.key === "panel.power.stc"));
  const coefficient = (key: string) =>
    properties.find((p) => p.model === panel.id && p.key === key)?.value ?? Number.NaN;
  assert.ok(
    Math.abs(coefficient("panel.voc.coefficient") - -0.3242) < 1e-6,
    "-0.0709998 V/K of a 21.9 V open-circuit voltage is -0.3242 %/K",
  );
  assert.ok(Math.abs(coefficient("panel.isc.coefficient") - 0.044642857) < 1e-6);
  assert.equal(coefficient("panel.power.coefficient"), -0.35, "already a share, read as it is");
  const window = properties.find((p) => p.model === inverter.id && p.key === "pv.mppt.window");
  assert.deepEqual(
    [window?.min, window?.max, window?.mappedBy],
    [100, 550, "feed:sam-cec/Lowest MPPT voltage,Highest MPPT voltage@1"],
  );
  const idle = properties.find((p) => p.model === inverter.id && p.key === "inverter.power.idle");
  assert.deepEqual(
    [idle?.value, idle?.conditions, idle?.source],
    [0.5, { mode: "night" }, "sam-cec-cec-inverters"],
  );
  assert.deepEqual(
    properties.find((p) => p.model === inverter.id && p.key === "inverter.voltage.ac")?.values,
    [240],
  );
});

test("a feed column the file gives no unit for, and no rule states one for, is a gap that says so", () => {
  const bare: FeedModel = {
    ...panel,
    specs: [{ name: "Open-circuit voltage", value: "21.9", conditions: "STC" }],
  };
  const { gaps } = build({ feeds: [{ feed, model: bare }] });
  assert.deepEqual(
    gaps.find((g) => g.key === "panel.voc.stc"),
    {
      model: panel.id,
      key: "panel.voc.stc",
      reason: "unparsed",
      detail: "no unit",
      claims: 1,
    },
  );
});

test("a coefficient in volts is read as a share of the STC figure the same model has, and is a gap without it", () => {
  const lumos: Mapping = Mapping.parse({
    id: "lumos",
    version: 1,
    reviewedBy: "ada",
    checkedAt: "2026-09-11",
    rules: [
      { key: "panel.voc.stc", names: ["Voc"], conditions: { stc: true }, basis: "the sheet" },
      {
        key: "panel.voc.coefficient",
        names: ["Temperature Coefficient of Voc"],
        basis: "the sheet",
      },
    ],
  });
  const model = Model.parse({
    id: "lumos-s32-190",
    manufacturer: "lumos",
    name: "S32-190",
    kind: "panel",
  });
  const withVoc = build({
    models: [model],
    mappings: [lumos],
    specs: [
      figure(model.id, "Voc", "40", { unit: "V" }),
      figure(model.id, "Temperature Coefficient of Voc", "-0.08 V/K"),
    ],
  });
  assert.equal(withVoc.properties.find((p) => p.key === "panel.voc.coefficient")?.value, -0.2);
  const withoutVoc = build({
    models: [model],
    mappings: [lumos],
    specs: [figure(model.id, "Temperature Coefficient of Voc", "-0.08 V/K")],
  });
  assert.match(
    withoutVoc.gaps.find((g) => g.key === "panel.voc.coefficient")?.detail ?? "",
    /needs the figure it is a share of/,
  );
});

test("a model nothing has classified, or one out of scope, has no keys and no gaps", () => {
  const { properties, gaps, coverage } = build({
    models: [
      Model.parse({ id: "x-1", manufacturer: "x", name: "1" }),
      Model.parse({ id: "x-2", manufacturer: "x", name: "2", kind: "out-of-scope" }),
    ],
  });
  assert.deepEqual([properties, gaps, coverage], [[], [], []]);
});

const shared: Mapping = Mapping.parse({
  id: "shared",
  version: 1,
  reviewedBy: "ada",
  checkedAt: "2026-09-11",
  rules: [
    {
      key: "pv.voc.max",
      names: ["Maximum PV open circuit voltage"],
      basis: "says in full what it measures",
    },
    {
      key: "charge.current.max",
      names: ["Maximum charge current"],
      basis: "says in full what it measures",
    },
  ],
});
const newcomer = Model.parse({
  id: "acme-mppt-40",
  manufacturer: "acme",
  name: "MPPT 40",
  kind: "charge-controller",
});
const newcomerFigures = [
  figure(newcomer.id, "Maximum PV open circuit voltage", "150", { unit: "V" }),
  figure(newcomer.id, "Maximum charge current", "40", { unit: "A" }),
  figure(newcomer.id, "Max. input voltage", "100", { unit: "V" }),
];
const acme = (over: Partial<Mapping>): Mapping =>
  Mapping.parse({
    id: "acme",
    version: 1,
    reviewedBy: "ada",
    checkedAt: "2026-09-11",
    rules: [{ key: "pv.mppt.window", names: ["MPPT range"], basis: "the sheet" }],
    ...over,
  });

test("a maker with no mapping of its own gets the shared mapping's values, cited as the shared rule", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [shared],
    specs: newcomerFigures,
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.mappedBy]),
    [
      ["charge.current.max", 40, "rule:shared@1#2"],
      ["pv.voc.max", 150, "rule:shared@1#1"],
    ],
  );
  // A maker's own wording is not the shared mapping's business.
  assert.deepEqual(
    gaps.find((g) => g.key === "pv.power.max"),
    { model: newcomer.id, key: "pv.power.max", reason: "no-claim", claims: 0 },
  );
});

test("a maker's own rule comes before the shared one, and a name it reads under any key is read once", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [
      shared,
      acme({
        rules: [
          {
            key: "pv.voc.max",
            names: ["Maximum PV open circuit voltage"],
            conditions: { ambientTemperature: 25 },
            basis: "the sheet states the limit at 25 °C",
          },
          // The maker's sheets print the PV short-circuit limit under the shared name for the
          // charge current, so the maker's rule takes the name and the shared rule leaves it.
          { key: "pv.isc.max", names: ["Maximum charge current"], basis: "the sheet" },
        ],
      }),
    ],
    specs: newcomerFigures,
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.mappedBy, p.conditions]),
    [
      ["pv.isc.max", 40, "rule:acme@1#2", {}],
      ["pv.voc.max", 150, "rule:acme@1#1", { ambientTemperature: 25 }],
    ],
  );
  assert.deepEqual(
    gaps.find((g) => g.key === "charge.current.max"),
    { model: newcomer.id, key: "charge.current.max", reason: "no-claim", claims: 0 },
  );
});

test("a shared name a maker sets aside in `except` is read by no shared rule, and the rest still are", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [shared, acme({ except: ["Maximum charge current"] })],
    specs: newcomerFigures,
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.mappedBy]),
    [["pv.voc.max", 150, "rule:shared@1#1"]],
  );
  assert.deepEqual(
    gaps.find((g) => g.key === "charge.current.max"),
    { model: newcomer.id, key: "charge.current.max", reason: "no-claim", claims: 0 },
  );
});

test("a figure per input beside the unit's total under one key are two properties, not a conflict", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [
      acme({
        rules: [
          { key: "pv.power.max", names: ["Max PV input power"], basis: "the sheet" },
          {
            key: "pv.power.max",
            names: ["Max input power per MPPT"],
            scope: "per-input",
            basis: "the sheet states it per tracker",
          },
        ],
      }),
    ],
    specs: [
      figure(newcomer.id, "Max PV input power", "13000", { unit: "W" }),
      figure(newcomer.id, "Max input power per MPPT", "6500", { unit: "W" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.value, p.scope, p.status]),
    [
      [6500, "per-input", "value"],
      [13000, "total", "value"],
    ],
  );
  assert.ok(!gaps.some((g) => g.key === "pv.power.max"));
});

test("a maker's rule scoped to one document leaves the same name on another document to the shared rule", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [
      shared,
      acme({
        rules: [
          {
            key: "pv.voc.max",
            names: ["Maximum PV open circuit voltage"],
            source: "doc-a",
            conditions: { ambientTemperature: 25 },
            basis: "this sheet states the limit at 25 °C",
          },
        ],
      }),
    ],
    specs: [
      figure(newcomer.id, "Maximum PV open circuit voltage", "150", { unit: "V" }),
      figure(newcomer.id, "Maximum PV open circuit voltage", "140", { unit: "V", source: "doc-b" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.value, p.mappedBy, p.conditions]),
    [
      [150, "rule:acme@1#1", { ambientTemperature: 25 }],
      [140, "rule:shared@1#1", {}],
    ],
  );
  assert.ok(!gaps.some((g) => g.key === "pv.voc.max"));
});

test("a charger's current rating keeps the ambient temperature its sheet states it at", () => {
  const { properties } = build({
    models: [newcomer],
    mappings: [
      acme({
        rules: [
          {
            key: "charge.current.max",
            names: ["Charging current at 25°C"],
            basis: "the sheet rates the charger at 25 °C",
          },
        ],
      }),
    ],
    specs: [figure(newcomer.id, "Charging current at 25°C", "35", { unit: "A" })],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.conditions]),
    [["charge.current.max", 35, { ambientTemperature: 25 }]],
  );
});

test("a maker's rule for a key the model's kind does not have leaves the name to the shared rule", () => {
  const { properties } = build({
    models: [newcomer],
    mappings: [
      shared,
      acme({
        // The maker's batteries print the same name; the rule is theirs, not the controller's.
        rules: [
          { key: "battery.charge.current.max", names: ["Maximum charge current"], basis: "packs" },
        ],
      }),
    ],
    specs: newcomerFigures,
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.mappedBy]),
    [
      ["charge.current.max", 40, "rule:shared@1#2"],
      ["pv.voc.max", 150, "rule:shared@1#1"],
    ],
  );
});

test("on a key with no scope dimension, figures that disagree are a conflict whatever scope a rule claims", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [
      acme({
        rules: [
          { key: "battery.voltage.nominal", names: ["Nominal voltage"], basis: "the sheet" },
          {
            key: "battery.voltage.nominal",
            names: ["System voltage"],
            scope: "total",
            basis: "the sheet, with a scope that means nothing here",
          },
        ],
      }),
    ],
    specs: [
      figure(newcomer.id, "Nominal voltage", "12", { unit: "V" }),
      figure(newcomer.id, "System voltage", "24", { unit: "V" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.values, p.scope, p.status]),
    [
      [[12], undefined, "conflict"],
      [[24], undefined, "conflict"],
    ],
  );
  assert.equal(gaps.find((g) => g.key === "battery.voltage.nominal")?.reason, "conflict");
});

test("a figure two of a maker's rules name under one key is read once, by the first rule", () => {
  const { properties, gaps } = build({
    models: [newcomer],
    mappings: [
      acme({
        rules: [
          {
            key: "pv.voc.max",
            names: ["Maximum PV open circuit voltage"],
            source: "doc-a",
            unit: "V",
            basis: "this sheet's table is headed in volts",
          },
          { key: "pv.voc.max", names: ["Maximum PV open circuit voltage"], basis: "the sheets" },
        ],
      }),
    ],
    specs: [figure(newcomer.id, "Maximum PV open circuit voltage", "150")],
  });
  assert.deepEqual(
    properties.map((p) => [p.value, p.mappedBy]),
    [[150, "rule:acme@1#1"]],
  );
  assert.ok(!gaps.some((g) => g.key === "pv.voc.max"));
});

const hybrid = Model.parse({
  id: "acme-hybrid-3000",
  manufacturer: "acme",
  name: "Hybrid 3000",
  kind: "inverter-charger",
});

test("a figure a sheet prints in VA under a watt name is read under the key's apparent-power sibling, by the same rule", () => {
  const { properties, gaps } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [
          {
            key: "inverter.power.continuous",
            names: ["Continuous output power at 25°C ambient"],
            basis: "the sheet",
          },
          {
            key: "inverter.power.surge",
            names: ["Overload capability 5 second", "Overload capability - surge"],
            basis: "the sheet",
          },
        ],
      }),
    ],
    specs: [
      figure(hybrid.id, "Continuous output power at 25°C ambient", "3000", { unit: "VA" }),
      figure(hybrid.id, "Overload capability 5 second", "5.75", { unit: "kVA" }),
      figure(hybrid.id, "Overload capability - surge", "6000", { unit: "VA" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.unit, p.conditions, p.mappedBy]),
    [
      ["inverter.power.apparent", 3000, "VA", { ambientTemperature: 25 }, "rule:acme@1#1"],
      ["inverter.power.apparent.surge", 5750, "VA", { duration: 5 }, "rule:acme@1#2"],
    ],
  );
  // The watt keys were never claimed; the VA surge without a time is the sibling's gap.
  assert.deepEqual(
    gaps
      .map((g) => [g.key, g.reason, g.claims])
      .filter(([k]) => String(k).startsWith("inverter.power")),
    [
      ["inverter.power.apparent.surge", "needs-conditions", 2],
      ["inverter.power.continuous", "no-claim", 0],
      ["inverter.power.idle", "no-claim", 0],
      ["inverter.power.surge", "no-claim", 0],
    ],
  );
});

test("a figure in watts stays on the watt key, and one in VA named under the apparent key directly is read there", () => {
  const { properties } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [
          { key: "inverter.power.continuous", names: ["Continuous output power"], basis: "w" },
          { key: "inverter.power.apparent", names: ["Apparent power rating"], basis: "va" },
        ],
      }),
    ],
    specs: [
      figure(hybrid.id, "Continuous output power", "2500", { unit: "W" }),
      figure(hybrid.id, "Apparent power rating", "3000", { unit: "VA" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.unit]),
    [
      ["inverter.power.apparent", 3000, "VA"],
      ["inverter.power.continuous", 2500, "W"],
    ],
  );
});

test("a VA figure the parser refuses is still the apparent key's gap, not the watt key's", () => {
  const { properties, gaps } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [
          { key: "inverter.power.continuous", names: ["Continuous output power"], basis: "w" },
        ],
      }),
    ],
    specs: [
      figure(hybrid.id, "Continuous output power", "up to 500 VA"),
      figure(hybrid.id, "Continuous output power", "3000-4000", { unit: "VA", source: "doc-b" }),
    ],
  });
  assert.deepEqual(properties, []);
  assert.deepEqual(
    gaps.filter((g) => g.key.startsWith("inverter.power.")).map((g) => [g.key, g.reason, g.claims]),
    [
      ["inverter.power.apparent", "unparsed", 2],
      ["inverter.power.apparent.surge", "no-claim", 0],
      ["inverter.power.continuous", "no-claim", 0],
      ["inverter.power.idle", "no-claim", 0],
      ["inverter.power.surge", "no-claim", 0],
    ],
  );
});

test("a value printed in VA and W feeds both keys, and a VA value with words after its unit is the apparent key's gap", () => {
  const { properties, gaps } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [{ key: "inverter.power.continuous", names: ["Rated output power"], basis: "w" }],
      }),
    ],
    specs: [
      figure(hybrid.id, "Rated output power", "6KVA/6KW"),
      figure(hybrid.id, "Rated output power", "4000 VA per phase", { source: "doc-b" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.unit, p.claim]),
    [
      ["inverter.power.apparent", 6000, "VA", `${hybrid.id}--rated-output-power`],
      ["inverter.power.continuous", 6000, "W", `${hybrid.id}--rated-output-power`],
    ],
  );
  assert.deepEqual(
    gaps
      .filter((g) => g.key.startsWith("inverter.power."))
      .map((g) => [g.key, g.reason, g.detail, g.claims]),
    [
      [
        "inverter.power.apparent",
        "unparsed",
        '"VAperphase" is not a unit, beside 1 usable figure',
        2,
      ],
      ["inverter.power.apparent.surge", "no-claim", undefined, 0],
      ["inverter.power.idle", "no-claim", undefined, 0],
      ["inverter.power.surge", "no-claim", undefined, 0],
    ],
  );
});

test("a VA figure with a rated voltage in its annotation goes by its unit field to the apparent key", () => {
  const { properties, gaps } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [{ key: "inverter.power.continuous", names: ["Rated output power"], basis: "w" }],
      }),
    ],
    specs: [figure(hybrid.id, "Rated output power", "6000 @ 240 VAC", { unit: "VA" })],
  });
  assert.deepEqual(properties, []);
  assert.deepEqual(
    gaps
      .filter((g) => g.key === "inverter.power.apparent" || g.key === "inverter.power.continuous")
      .map((g) => [g.key, g.reason, g.claims]),
    [
      ["inverter.power.apparent", "unparsed", 1],
      ["inverter.power.continuous", "no-claim", 0],
    ],
  );
});

test("a bounded value in VA and W is refused on both keys, not read as two exact figures", () => {
  const { properties, gaps } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [{ key: "inverter.power.continuous", names: ["Rated output power"], basis: "w" }],
      }),
    ],
    specs: [figure(hybrid.id, "Rated output power", "up to 6KVA/6KW")],
  });
  assert.deepEqual(properties, []);
  assert.deepEqual(
    gaps
      .filter((g) => g.key === "inverter.power.apparent" || g.key === "inverter.power.continuous")
      .map((g) => [g.key, g.reason, g.detail]),
    [
      ["inverter.power.apparent", "unparsed", "a bound or an approximation, not a figure"],
      ["inverter.power.continuous", "unparsed", "a bound or an approximation, not a figure"],
    ],
  );
});

test("a quantity printed twice around another is refused on its key rather than read from the first part", () => {
  const { properties, gaps } = build({
    models: [hybrid],
    mappings: [
      acme({
        rules: [{ key: "inverter.power.continuous", names: ["Rated output power"], basis: "w" }],
      }),
    ],
    specs: [
      figure(hybrid.id, "Rated output power", "6KVA/5KW/4KVA"),
      // A unit field does not hide the quantities in the text.
      figure(hybrid.id, "Rated output power", "3KVA/3KW", { unit: "VA", source: "doc-b" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.unit, p.status]),
    [
      ["inverter.power.apparent", 3000, "VA", "value"],
      ["inverter.power.continuous", 5000, "W", "conflict"],
      ["inverter.power.continuous", 3000, "W", "conflict"],
    ],
  );
  assert.deepEqual(
    gaps.find((g) => g.key === "inverter.power.apparent"),
    {
      model: hybrid.id,
      key: "inverter.power.apparent",
      reason: "unparsed",
      detail: "a set where a scalar is needed, beside 1 usable figure",
      claims: 2,
    },
  );
});

const pack = (id: string, chemistry?: string) =>
  Model.parse({
    id,
    manufacturer: "acme",
    name: id,
    kind: "battery",
    ...(chemistry ? { chemistry, chemistryBasis: "name" } : {}),
  });
const capacity = acme({
  rules: [
    {
      key: "battery.capacity",
      names: ["Capacity", "Capacity at 20 Hour Rate"],
      basis: "the sheets",
    },
  ],
});

test("a lithium pack's capacity stands without a rate; a lead-acid pack's and an unstated chemistry's need one", () => {
  const lithium = pack("acme-lfp-200", "lifepo4");
  const agm = pack("acme-agm-200", "agm");
  const unknown = pack("acme-x-200");
  const { properties, gaps } = build({
    models: [lithium, agm, unknown],
    mappings: [capacity],
    specs: [
      figure(lithium.id, "Capacity", "200", { unit: "Ah" }),
      figure(agm.id, "Capacity", "200", { unit: "Ah" }),
      figure(agm.id, "Capacity at 20 Hour Rate", "220", { unit: "Ah" }),
      figure(unknown.id, "Capacity", "200", { unit: "Ah" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.model, p.value, p.conditions]),
    [
      [agm.id, 220, { dischargeHours: 20 }],
      [lithium.id, 200, {}],
    ],
  );
  assert.deepEqual(
    gaps.filter((g) => g.key === "battery.capacity").map((g) => [g.model, g.reason, g.detail]),
    [
      [agm.id, "needs-conditions", "no dischargeHours stated, beside 1 usable figure"],
      [
        unknown.id,
        "needs-conditions",
        "no dischargeHours stated, and no chemistry recorded that would waive it",
      ],
    ],
  );
});

test("a model's chemistry is one the schema names, on a battery, with what established it", () => {
  assert.equal(pack("acme-gel-100", "gel").chemistry, "gel");
  assert.throws(() => pack("acme-ni-100", "nickel"));
  assert.throws(
    () =>
      Model.parse({
        id: "acme-inv",
        manufacturer: "acme",
        name: "x",
        kind: "inverter",
        chemistry: "agm",
        chemistryBasis: "name",
      }),
    /only a battery has a chemistry/,
  );
  assert.throws(
    () =>
      Model.parse({
        id: "acme-b",
        manufacturer: "acme",
        name: "x",
        kind: "battery",
        chemistry: "agm",
      }),
    /come together/,
  );
});

test("a lithium pack that states its rate keeps it, and two rates stay two properties", () => {
  const lithium = pack("acme-lfp-200", "lifepo4");
  const { properties, gaps } = build({
    models: [lithium],
    mappings: [capacity],
    specs: [
      figure(lithium.id, "Capacity", "200", { unit: "Ah" }),
      figure(lithium.id, "Capacity at 20 Hour Rate", "210", { unit: "Ah" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.value, p.conditions, p.status]),
    [
      [200, {}, "value"],
      [210, { dischargeHours: 20 }, "value"],
    ],
  );
  assert.ok(!gaps.some((g) => g.key === "battery.capacity"));
});

const genset = Model.parse({
  id: "acme-genset-5500",
  manufacturer: "acme",
  name: "Genset 5500",
  kind: "generator",
});

test("a rule for one part of a cell reads that part, by fuel where the name says it, and skips a value with fewer parts", () => {
  const { properties, gaps } = build({
    models: [genset],
    mappings: [
      acme({
        rules: [
          {
            key: "generator.power.starting",
            names: ["Watts (Starting/Running)", "Watts (LPG) (Starting/Running)"],
            part: 1,
            basis: "the first figure",
          },
          {
            key: "generator.power.running",
            names: ["Watts (Starting/Running)", "Watts (LPG) (Starting/Running)"],
            part: 2,
            basis: "the second figure",
          },
          { key: "generator.fuel.tank", names: ["Gasoline Capacity"], basis: "the tank" },
        ],
      }),
    ],
    specs: [
      // A name ending in a bracket would make an id ending in a dash, which the schema refuses.
      figure(genset.id, "Watts (Starting/Running)", "5500/4000", {
        unit: "W",
        id: `${genset.id}--watts-starting-running`,
      }),
      figure(genset.id, "Watts (LPG) (Starting/Running)", "4500/3600", {
        unit: "W",
        id: `${genset.id}--watts-lpg-starting-running`,
      }),
      figure(genset.id, "Gasoline Capacity", "2.25 gal. (8.50 L)"),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.unit, p.conditions.fuel]),
    [
      ["generator.fuel.tank", 8.517176514, "L", "gasoline"],
      ["generator.power.running", 3600, "W", "lpg"],
      ["generator.power.running", 4000, "W", undefined],
      ["generator.power.starting", 4500, "W", "lpg"],
      ["generator.power.starting", 5500, "W", undefined],
    ],
  );
  assert.deepEqual(
    gaps.filter((g) => g.key.startsWith("generator.")),
    [],
  );
  // A cell with one figure has no second part; a rule for it reads nothing, and the first-part rule reads it whole.
  const lone = build({
    models: [genset],
    mappings: [
      acme({
        rules: [{ key: "generator.power.running", names: ["Watts"], part: 2, basis: "the second" }],
      }),
    ],
    specs: [figure(genset.id, "Watts", "4000", { unit: "W" })],
  });
  assert.deepEqual(
    lone.gaps.filter((g) => g.key === "generator.power.running").map((g) => [g.reason, g.claims]),
    [["no-claim", 0]],
  );
});

test("a duration in a value's aside is the peak's condition on a key that takes one, and a different figure on a key that does not", () => {
  const cell = Model.parse({
    id: "acme-cell-100",
    manufacturer: "acme",
    name: "Cell 100",
    kind: "battery",
  });
  const { properties, gaps } = build({
    models: [cell],
    mappings: [
      acme({
        rules: [
          { key: "battery.discharge.current.peak", names: ["Peak current"], basis: "the sheet" },
          { key: "battery.discharge.current.max", names: ["Max current"], basis: "the sheet" },
        ],
      }),
    ],
    specs: [
      figure(cell.id, "Peak current", "200A (15s)"),
      figure(cell.id, "Max current", "200A (15s)"),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.conditions.duration]),
    [["battery.discharge.current.peak", 200, 15]],
  );
  assert.deepEqual(
    gaps.filter((g) => g.key === "battery.discharge.current.max").map((g) => [g.reason, g.detail]),
    [["unparsed", "an aside states a duration the key does not take"]],
  );
});

test("a condition the value's aside states wins over the name's wording, and a name that contradicts the aside is refused", () => {
  const cell = Model.parse({
    id: "acme-cell-200",
    manufacturer: "acme",
    name: "Cell 200",
    kind: "battery",
  });
  const { properties, gaps } = build({
    models: [cell],
    mappings: [
      acme({
        rules: [
          {
            key: "battery.discharge.current.peak",
            names: ["Surge current", "5 sec surge current"],
            basis: "the sheet",
          },
        ],
      }),
    ],
    specs: [
      figure(cell.id, "Surge current", "200A (15s)"),
      figure(cell.id, "5 sec surge current", "300A (15s)", { source: "doc-b" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.value, p.conditions.duration]),
    [[200, 15]],
  );
  assert.deepEqual(
    gaps.filter((g) => g.key === "battery.discharge.current.peak").map((g) => [g.reason, g.detail]),
    [["unparsed", "the name and the value state different duration, beside 1 usable figure"]],
  );
});

test("an aside that restates the figure names no condition, and alternatives under different conditions are refused", () => {
  const charger = Model.parse({
    id: "acme-charger-5",
    manufacturer: "acme",
    name: "Charger 5",
    kind: "ac-charger",
  });
  const cell = Model.parse({
    id: "acme-cell-300",
    manufacturer: "acme",
    name: "Cell 300",
    kind: "battery",
  });
  const { properties, gaps } = build({
    models: [charger, cell],
    mappings: [
      acme({
        rules: [
          { key: "battery.voltage.nominal", names: ["Nominal voltage"], basis: "the sheet" },
          { key: "charge.current.max", names: ["Charging current"], basis: "the sheet" },
        ],
      }),
    ],
    specs: [
      figure(cell.id, "Nominal voltage", "12000mV (12V)"),
      figure(charger.id, "Charging current", "5A (12V)/5A (24V)"),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.values, p.conditions]),
    [["battery.voltage.nominal", [12], {}]],
  );
  assert.deepEqual(
    gaps.filter((g) => g.key === "charge.current.max").map((g) => [g.reason, g.detail]),
    [["unparsed", "the alternatives are stated under different conditions"]],
  );
});

test("an aside that structures into nothing the property keeps is refused, and an aside is seen past a duration suffix", () => {
  const charger = Model.parse({
    id: "acme-charger-6",
    manufacturer: "acme",
    name: "Charger 6",
    kind: "ac-charger",
  });
  const cell = Model.parse({
    id: "acme-cell-400",
    manufacturer: "acme",
    name: "Cell 400",
    kind: "battery",
  });
  const { properties, gaps } = build({
    models: [charger, cell],
    mappings: [
      acme({
        rules: [
          { key: "charge.current.max", names: ["Charging current"], basis: "the sheet" },
          { key: "battery.discharge.current.peak", names: ["Peak current"], basis: "the sheet" },
        ],
      }),
    ],
    specs: [
      figure(charger.id, "Charging current", "5A (120V)"),
      figure(cell.id, "Peak current", "300A (15s) for 10s"),
      figure(cell.id, "Peak current", "250A (10s) for 10s", { source: "doc-b" }),
    ],
  });
  assert.deepEqual(
    properties.map((p) => [p.key, p.value, p.conditions.duration]),
    [["battery.discharge.current.peak", 250, 10]],
  );
  assert.deepEqual(
    gaps
      .filter((g) => g.claims > 0)
      .map((g) => [g.key, g.reason, g.detail])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      [
        "battery.discharge.current.peak",
        "unparsed",
        "the name and the value state different duration, beside 1 usable figure",
      ],
      [
        "charge.current.max",
        "unparsed",
        'an aside states something the figure cannot keep: "(120V)"',
      ],
    ],
  );
});

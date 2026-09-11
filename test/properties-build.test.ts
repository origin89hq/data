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
      conflicts: 0,
      noClaim: 0,
      unparsed: 0,
      needsConditions: 0,
    },
  );
  assert.equal(coverage.find((c) => c.key === "pv.isc.max")?.noClaim, 1);
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
      detail: '"%ofthecontroller’soutputcurrentrating(approximate)" is not a unit',
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
      detail: "no dischargeHours stated",
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

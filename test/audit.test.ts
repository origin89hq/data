import assert from "node:assert/strict";
import { test } from "node:test";
import { Mapping } from "@origin89/equipment-schema/mapping";
import { Model, Spec } from "@origin89/equipment-schema/model";
import { auditMappings } from "../src/audit.ts";
import { buildProperties } from "../src/properties.ts";
import type { Records } from "../src/records.ts";
import { unmappedFigures } from "../tools/mappings/unmapped.ts";

const READER = "ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast@p2";
const figure = (model: string, name: string, value: string, over: Partial<Spec> = {}): Spec =>
  Spec.parse({
    id: `${model}--${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+$/, "")}`,
    model,
    name,
    value,
    source: "doc-a",
    extractedBy: READER,
    confidence: "vendor-doc",
    ...over,
  });
const model = (id: string, kind: string): Model =>
  Model.parse({ id, manufacturer: "acme", name: id, kind });
const mapping = (rules: unknown[], over: Partial<Mapping> = {}): Mapping =>
  Mapping.parse({
    id: "acme",
    version: 1,
    reviewedBy: "ada",
    checkedAt: "2026-09-12",
    rules,
    ...over,
  });

function records(models: Model[], specs: Spec[], mappings: Mapping[]): Records {
  return {
    families: [],
    dialects: [],
    sources: [{ id: "doc-a", url: "https://x/a" }],
    manufacturers: [{ id: "acme", name: "Acme", domains: ["acme.example"] }],
    brands: [],
    models,
    specs,
    mappings,
  };
}
const audit = (r: Records) =>
  auditMappings(
    r,
    buildProperties({ models: r.models, specs: r.specs, mappings: r.mappings, feeds: [] }),
  );

test("a mapping whose rules read every figure they name, with units and no near misses, audits clean", () => {
  const controller = model("acme-mppt-40", "charge-controller");
  const r = records(
    [controller],
    [figure(controller.id, "Max PV Voc", "150", { unit: "V" })],
    [mapping([{ key: "pv.voc.max", names: ["Max PV Voc"], basis: "the sheet" }])],
  );
  assert.deepEqual(audit(r), { errors: [], notes: [] });
});

test("a figure a rule names under a key the model's kind has, that no key read, is a defect", () => {
  const controller = model("acme-mppt-40", "charge-controller");
  const r = records(
    [controller],
    [figure(controller.id, "Max PV Voc", "150", { unit: "V" })],
    [mapping([{ key: "pv.voc.max", names: ["Max PV Voc"], basis: "the sheet" }])],
  );
  // The build says it read nothing: the audit has caught a builder that dropped the figure.
  const { errors } = auditMappings(r, { claimed: new Set() });
  assert.deepEqual(errors, [
    'mapping acme rule 1: names "Max PV Voc" on acme-mppt-40, a charge-controller the key pv.voc.max applies to, but no key read it',
  ]);
});

test("a maker's rule naming a figure of a kind its key does not have is noted, since the figure is never read", () => {
  const bms = model("acme-bms-100", "bms");
  const r = records(
    [bms],
    [figure(bms.id, "Maximum DC Output", "45", { unit: "A" })],
    [mapping([{ key: "charge.current.max", names: ["Maximum DC Output"], basis: "the sheet" }])],
  );
  const { errors, notes } = audit(r);
  assert.deepEqual(errors, []);
  assert.deepEqual(notes, [
    'mapping acme rule 1: names "Maximum DC Output" on acme-bms-100, a bms, which charge.current.max does not apply to; the figure is not read',
  ]);
});

test("a rule for one part of a cell is not faulted for a value with fewer parts, which it does not read", () => {
  const genset = model("acme-genset-5500", "generator");
  const r = records(
    [genset],
    [
      figure(genset.id, "Watts", "5500/4000", { unit: "W" }),
      figure(genset.id, "Watts", "4000", {
        unit: "W",
        id: `${genset.id}--watts-lone`,
        source: "doc-a",
      }),
    ],
    [
      mapping([
        { key: "generator.power.starting", names: ["Watts"], part: 1, basis: "the first" },
        { key: "generator.power.running", names: ["Watts"], part: 2, basis: "the second" },
      ]),
    ],
  );
  // Neither an error nor a near-miss note: the rule names the figure, it just has no second part.
  assert.deepEqual(audit(r), { errors: [], notes: [] });
});

test("an unmapped name one step from a mapped one is noted, a lone word is not", () => {
  const battery = model("acme-cell-200", "battery");
  const r = records(
    [battery],
    [
      figure(battery.id, "Voltage Per Unit", "12", { unit: "V" }),
      figure(battery.id, "Voltage Per Unit (nominal)", "12", { unit: "V" }),
      figure(battery.id, "Nominal DC Input Voltage Range", "12", { unit: "V" }),
      figure(battery.id, "Rating", "200", { unit: "Ah" }),
    ],
    [
      mapping([
        { key: "battery.voltage.nominal", names: ["Voltage Per Unit"], basis: "the sheet" },
        { key: "battery.voltage.nominal", names: ["Nominal DC Input Voltage"], basis: "the sheet" },
        { key: "battery.capacity", names: ["Surge rating"], basis: "the sheet" },
      ]),
    ],
  );
  assert.deepEqual(
    audit(r).notes.filter((n) => n.includes("one step")),
    [
      'mapping acme: "Nominal DC Input Voltage Range" (1 figure) is one step from the mapped "Nominal DC Input Voltage" and is not read',
      'mapping acme: "Voltage Per Unit (nominal)" (1 figure) is one step from the mapped "Voltage Per Unit" and is not read',
    ],
  );
});

test("figures a rule reads without a unit, and conditions a key drops, are noted per rule", () => {
  const hybrid = model("acme-hybrid-3000", "inverter-charger");
  const r = records(
    [hybrid],
    [
      figure(hybrid.id, "Output Power", "1000"),
      figure(hybrid.id, "Charger output at 25°C", "105", { unit: "A" }),
    ],
    [
      mapping([
        { key: "inverter.power.continuous", names: ["Output Power"], basis: "the sheet" },
        { key: "pv.isc.max", names: ["Charger output at 25°C"], basis: "the sheet" },
      ]),
    ],
  );
  assert.deepEqual(
    audit(r).notes.filter((n) => n.includes("rule 1") || n.includes("rule 2")),
    [
      'mapping acme rule 1 (inverter.power.continuous): 1 of 1 figures print no unit and the rule names none, so they are gaps: "Output Power" = "1000" on acme-hybrid-3000',
      "mapping acme rule 2 (pv.isc.max): 1 figure state a ambientTemperature the key does not keep",
    ],
  );
});

test("a model filed as an inverter whose sheet prints a charger's output is noted", () => {
  const inverter = model("acme-vfx-3648", "inverter");
  const r = records(
    [inverter],
    [figure(inverter.id, "Continuous Battery Charger Output", "80 amps DC")],
    [mapping([{ key: "pv.voc.max", names: ["Nothing"], basis: "the sheet" }])],
  );
  assert.ok(
    audit(r).notes.some((n) =>
      n.startsWith(
        'model acme-vfx-3648 is filed as an inverter but prints a charger\'s output, "Continuous Battery Charger Output"',
      ),
    ),
  );
});

test("the drafting list leaves a name a rule reads on one document unmapped on every other", () => {
  const hybrid = model("acme-hybrid-3000", "inverter-charger");
  const r = records(
    [hybrid],
    [
      figure(hybrid.id, "Output voltage", "230", { unit: "V" }),
      figure(hybrid.id, "Output voltage", "120", { unit: "V", source: "doc-b" }),
      figure(hybrid.id, "Weight", "12", { unit: "kg" }),
    ],
    [
      mapping([
        {
          key: "inverter.voltage.ac",
          names: ["Output voltage"],
          source: "doc-a",
          basis: "one sheet",
        },
      ]),
    ],
  );
  r.sources.push({ id: "doc-b", url: "https://x/b" });
  assert.deepEqual(
    unmappedFigures(r, "acme").map((s) => [s.name, s.source]),
    [
      ["Output voltage", "doc-b"],
      ["Weight", "doc-a"],
    ],
  );
});

test("the drafting list counts a shared name the maker set aside under `except` as unmapped", () => {
  const hybrid = model("acme-hybrid-3000", "inverter-charger");
  const shared = Mapping.parse({
    id: "shared",
    version: 1,
    reviewedBy: "ada",
    checkedAt: "2026-09-12",
    rules: [{ key: "pv.power.max", names: ["Max. Allowed PV Power"], basis: "everywhere" }],
  });
  const r = records(
    [hybrid],
    [figure(hybrid.id, "Max. Allowed PV Power", "13000", { unit: "W" })],
    [
      shared,
      mapping([{ key: "pv.voc.max", names: ["Max. Input Voltage"], basis: "the sheet" }], {
        except: ["Max. Allowed PV Power"],
      }),
    ],
  );
  assert.deepEqual(
    unmappedFigures(r, "acme").map((s) => s.name),
    ["Max. Allowed PV Power"],
  );
  assert.deepEqual(unmappedFigures({ ...r, mappings: [shared] }, "acme"), []);
});

test("the drafting list keeps a figure a rule names on a kind the rule's key does not have", () => {
  const converter = model("acme-dc-100", "dc-dc-converter");
  const r = records(
    [converter],
    [figure(converter.id, "MPPT voltage range", "120-480 V")],
    [
      Mapping.parse({
        id: "shared",
        version: 1,
        reviewedBy: "ada",
        checkedAt: "2026-09-12",
        rules: [{ key: "pv.mppt.window", names: ["MPPT voltage range"], basis: "everywhere" }],
      }),
      mapping([{ key: "battery.voltage.nominal", names: ["Nominal voltage"], basis: "the sheet" }]),
    ],
  );
  assert.deepEqual(
    unmappedFigures(r, "acme").map((s) => s.name),
    ["MPPT voltage range"],
  );
});

test("a shared rule's unit-less figures and dropped conditions are noted for the maker they belong to", () => {
  const hybrid = model("acme-hybrid-3000", "inverter-charger");
  const r = records(
    [hybrid],
    [figure(hybrid.id, "MPP operating voltage range", "120-480")],
    [
      Mapping.parse({
        id: "shared",
        version: 1,
        reviewedBy: "ada",
        checkedAt: "2026-09-12",
        rules: [
          { key: "pv.mppt.window", names: ["MPP operating voltage range"], basis: "everywhere" },
        ],
      }),
      mapping([{ key: "battery.voltage.nominal", names: ["Nominal voltage"], basis: "the sheet" }]),
    ],
  );
  assert.deepEqual(
    audit(r).notes.filter((n) => n.startsWith("shared rule")),
    [
      'shared rule 1 on acme (pv.mppt.window): 1 of 1 figures print no unit and the rule names none, so they are gaps: "MPP operating voltage range" = "120-480" on acme-hybrid-3000',
    ],
  );
});

test("a maker with no file of its own is audited through the shared rules, without the near-miss list", () => {
  const hybrid = model("acme-hybrid-3000", "inverter-charger");
  const shared = Mapping.parse({
    id: "shared",
    version: 1,
    reviewedBy: "ada",
    checkedAt: "2026-09-12",
    rules: [{ key: "inverter.power.continuous", names: ["Rated AC power"], basis: "everywhere" }],
  });
  const r = records(
    [hybrid],
    [
      figure(hybrid.id, "Rated AC power", "3000"),
      figure(hybrid.id, "Rated AC power output", "3000", { unit: "W" }),
    ],
    [shared],
  );
  assert.deepEqual(audit(r).notes, [
    'shared rule 1 on acme (inverter.power.continuous): 1 of 1 figures print no unit and the rule names none, so they are gaps: "Rated AC power" = "3000" on acme-hybrid-3000',
  ]);
  // A build that dropped the shared claim is a defect for such a maker too.
  assert.deepEqual(auditMappings(r, { claimed: new Set() }).errors, [
    'shared rule 1 on acme: names "Rated AC power" on acme-hybrid-3000, a inverter-charger the key inverter.power.continuous applies to, but no key read it',
  ]);
});

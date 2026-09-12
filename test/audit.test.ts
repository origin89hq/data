import assert from "node:assert/strict";
import { test } from "node:test";
import { Mapping } from "@origin89/equipment-schema/mapping";
import { Model, Spec } from "@origin89/equipment-schema/model";
import { auditMappings } from "../src/audit.ts";
import { buildProperties } from "../src/properties.ts";
import type { Records } from "../src/records.ts";

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

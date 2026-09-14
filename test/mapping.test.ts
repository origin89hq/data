import assert from "node:assert/strict";
import { test } from "node:test";
import { Mapping, MappingRule } from "@origin89/equipment-schema/mapping";
import type { Records } from "../src/records.ts";
import { validate } from "../src/validate.ts";

const rule = { key: "pv.voc.max", names: ["Max. input voltage"], basis: "the sheet" };
const good = {
  id: "victron-energy",
  version: 1,
  reviewedBy: "ada",
  checkedAt: "2026-09-11",
  rules: [rule],
};

test("a mapping names its maker, its version, its reviewer and at least one rule, and nothing else", () => {
  Mapping.parse(good);
  Mapping.parse({
    ...good,
    rules: [{ ...rule, source: "doc-a", unit: "V", conditions: { stc: true }, scope: "total" }],
  });
  assert.throws(() => Mapping.parse({ ...good, rules: [] }));
  assert.throws(() => Mapping.parse({ ...good, rules: [{ ...rule, key: "PvVoc" }] }));
  assert.throws(() => Mapping.parse({ ...good, rules: [{ ...rule, names: [] }] }));
  assert.throws(() => Mapping.parse({ ...good, rules: [{ ...rule, basis: "" }] }));
  assert.throws(() => Mapping.parse({ ...good, rules: [{ ...rule, extra: true }] }));
  assert.throws(() => Mapping.parse({ ...good, version: 0 }));
  assert.throws(() => Mapping.parse({ ...good, checkedAt: "yesterday" }));
  assert.throws(() => Mapping.parse({ ...good, reviewedBy: "" }));
});

function fixture(mapping: unknown = good): Records {
  return {
    families: [],
    dialects: [],
    sources: [{ id: "doc-a", url: "https://x/a" }],
    manufacturers: [
      { id: "victron-energy", name: "Victron Energy", domains: ["victronenergy.com"] },
    ],
    brands: [],
    models: [
      {
        id: "victron-energy-x",
        manufacturer: "victron-energy",
        name: "X",
        aliases: [],
        dialects: [],
      },
    ],
    specs: [
      {
        id: "victron-energy-x--max-input-voltage",
        model: "victron-energy-x",
        name: "Max. input voltage",
        value: "100",
        unit: "V",
        source: "doc-a",
        extractedBy: "ai:@cf/x@p1",
        confidence: "vendor-doc",
      },
    ],
    mappings: [Mapping.parse(mapping)],
  };
}

const errorsOf = (mapping: unknown) => validate(fixture(mapping)).errors.join("\n");

test("a mapping that reads a real figure of its maker under a registered key validates", () => {
  const report = validate(fixture());
  assert.deepEqual(report.errors, []);
  assert.equal(report.review["mapping rule that reads no figure of its maker"], undefined);
});

test("a rule for a key nobody registered, a source nobody holds, or a maker that does not exist is refused", () => {
  assert.match(
    errorsOf({ ...good, rules: [{ ...rule, key: "pv.voc.maximum" }] }),
    /rule 1: pv\.voc\.maximum is not in the property registry/,
  );
  assert.match(errorsOf({ ...good, rules: [{ ...rule, source: "doc-z" }] }), /cites doc-z/);
  assert.match(errorsOf({ ...good, id: "nobody" }), /mapping nobody: names a manufacturer/);
});

test("a rule's default unit has to be a unit of the key's quantity", () => {
  assert.match(
    errorsOf({ ...good, rules: [{ ...rule, unit: "furlongs" }] }),
    /"furlongs" is not a unit/,
  );
  assert.match(
    errorsOf({ ...good, rules: [{ ...rule, unit: "Ah" }] }),
    /Ah measures charge, not voltage/,
  );
  assert.equal(errorsOf({ ...good, rules: [{ ...rule, unit: "Vdc" }] }), "");
});

test("a rule that reads no figure is noted for review, since the figures may arrive with the next pull", () => {
  const report = validate(fixture({ ...good, rules: [{ ...rule, names: ["Something else"] }] }));
  assert.deepEqual(report.errors, []);
  assert.equal(report.review["mapping rule that reads no figure of its maker"], 1);
  const scoped = validate(fixture({ ...good, rules: [{ ...rule, source: "doc-a" }] }));
  assert.equal(scoped.review["mapping rule that reads no figure of its maker"], undefined);
});

test("a rule may require only a condition its key accepts, and must read kinds its key applies to", () => {
  assert.equal(errorsOf({ ...good, rules: [{ ...rule, requires: ["cellTemperature"] }] }), "");
  assert.match(
    errorsOf({ ...good, rules: [{ ...rule, requires: ["dischargeHours"] }] }),
    /requires dischargeHours, which pv\.voc\.max does not accept/,
  );
  const battery = fixture();
  battery.models[0] = { ...battery.models[0], kind: "battery" };
  assert.match(
    validate(battery).errors.join("\n"),
    /reads figures of battery, which pv\.voc\.max does not apply to/,
  );
  const controller = fixture();
  controller.models[0] = { ...controller.models[0], kind: "charge-controller" };
  assert.deepEqual(validate(controller).errors, []);
});

test("a review dated in the future, or a maker mapped twice, is an error", () => {
  assert.match(errorsOf({ ...good, checkedAt: "2999-01-01" }), /which has not happened/);
  const twice = fixture();
  twice.mappings.push(Mapping.parse(good));
  assert.match(validate(twice).errors.join("\n"), /mapping victron-energy: listed twice/);
});

const shared = {
  id: "shared",
  version: 1,
  reviewedBy: "ada",
  checkedAt: "2026-09-11",
  rules: [{ ...rule, names: ["Max. input voltage"] }],
};

test("the shared mapping names no manufacturer, reads every maker's figures, and cannot except its own names", () => {
  const report = validate(fixture(shared));
  assert.deepEqual(report.errors, []);
  assert.equal(report.review["shared mapping rule that reads no figure"], undefined);
  const idle = validate(fixture({ ...shared, rules: [{ ...rule, names: ["Something else"] }] }));
  assert.deepEqual(idle.errors, []);
  assert.equal(idle.review["shared mapping rule that reads no figure"], 1);
  assert.match(
    errorsOf({ ...shared, except: ["Max. input voltage"] }),
    /mapping shared: the shared mapping cannot except its own names/,
  );
});

test("a maker may except only a name some shared rule lists", () => {
  const both = fixture(shared);
  both.mappings.push(Mapping.parse({ ...good, except: ["max. input  voltage"] }));
  assert.deepEqual(validate(both).errors, []);
  const typo = fixture(shared);
  typo.mappings.push(Mapping.parse({ ...good, except: ["Max input voltage"] }));
  assert.match(
    validate(typo).errors.join("\n"),
    /mapping victron-energy: excepts "Max input voltage", which no shared rule names/,
  );
  assert.match(
    errorsOf({ ...good, except: ["Max. input voltage"] }),
    /excepts "Max\. input voltage", which no shared rule names/,
  );
});

test("a rule's part is a whole number counted from one", () => {
  const rule = { key: "generator.power.running", names: ["Watts"], basis: "the cell" };
  assert.equal(MappingRule.safeParse({ ...rule, part: 2 }).success, true);
  assert.equal(MappingRule.safeParse({ ...rule, part: 0 }).success, false);
  assert.equal(MappingRule.safeParse({ ...rule, part: 1.5 }).success, false);
});

test("a rule may set a scope only on a key that has one", () => {
  assert.equal(errorsOf({ ...good, rules: [{ ...rule, scope: "total" }] }), "");
  assert.match(
    errorsOf({
      ...good,
      rules: [{ ...rule, key: "battery.voltage.nominal", scope: "total" }],
    }),
    /rule 1: sets a scope, which battery\.voltage\.nominal does not have/,
  );
});

test("no manufacturer may take the shared mapping's id", () => {
  const taken = fixture();
  taken.manufacturers.push({ id: "shared", name: "Shared Power", domains: ["shared.example"] });
  assert.match(
    validate(taken).errors.join("\n"),
    /manufacturer shared: the id is the shared mapping's, not a maker's/,
  );
});

test("a chemistry established by a figure names one of the model's own", () => {
  const r = fixture();
  r.models[0] = {
    ...r.models[0],
    kind: "battery",
    chemistry: "lifepo4",
    chemistryBasis: "spec:victron-energy-x--max-input-voltage",
  };
  const chemistryErrors = (records: Records) =>
    validate(records).errors.filter((e) => /chemistry/.test(e));
  assert.deepEqual(chemistryErrors(r), []);
  r.models[0] = { ...r.models[0], chemistryBasis: "spec:somebody-else--chemistry" };
  assert.match(
    validate(r).errors.join("\n"),
    /chemistry cites somebody-else--chemistry, which is not a figure of this model/,
  );
});

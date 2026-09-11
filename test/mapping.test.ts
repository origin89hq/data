import assert from "node:assert/strict";
import { test } from "node:test";
import { Mapping } from "@origin89/equipment-schema/mapping";
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

test("a review dated in the future, or a maker mapped twice, is an error", () => {
  assert.match(errorsOf({ ...good, checkedAt: "2999-01-01" }), /which has not happened/);
  const twice = fixture();
  twice.mappings.push(Mapping.parse(good));
  assert.match(validate(twice).errors.join("\n"), /mapping victron-energy: listed twice/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DialectLink, Model } from "@origin89/equipment-schema/model";
import { foldDerived, namesOf } from "../src/model-records.ts";

const link = (dialect: string): DialectLink => ({
  dialect,
  evidence: { kind: "catalogue-name", sources: [] },
  confidence: "unverified",
});
const model = (
  manufacturer: string,
  id: string,
  name: string,
  extra: Partial<Model> = {},
): Model => ({
  id: `${manufacturer}-${id}`,
  manufacturer,
  name,
  aliases: [],
  dialects: [],
  ...extra,
});

test("a spelling a held model already lists as an alias folds into it instead of coming back as a record (#201)", () => {
  const held = [
    model("morningstar", "ts-45", "TS-45", { kind: "charge-controller", aliases: ["TS45"] }),
  ];
  const derived = model("morningstar", "ts45", "TS45", {
    kind: "charge-controller",
    aliases: ["XXX-XXX-131"],
    dialects: [link("morningstar-tristar-pwm")],
  });
  const { record, outcome } = foldDerived(held, derived);
  assert.equal(outcome, "folded");
  assert.equal(record.id, "morningstar-ts-45");
  assert.equal(record.name, "TS-45");
  assert.deepEqual(record.aliases, ["TS45", "XXX-XXX-131"]);
  assert.deepEqual(
    record.dialects.map((l) => l.dialect),
    ["morningstar-tristar-pwm"],
  );
});

test("another punctuation of a held name, or the maker's name in front, folds too, and the held kind stands", () => {
  const held = [model("samlex-america", "evo-4024", "EVO-4024", { kind: "inverter-charger" })];
  const bare = foldDerived(
    held,
    model("samlex-america", "evo4024", "EVO4024", { kind: "inverter" }),
  );
  assert.equal(bare.outcome, "folded");
  assert.equal(bare.record.id, "samlex-america-evo-4024");
  assert.equal(bare.record.kind, "inverter-charger");
  assert.deepEqual(bare.record.aliases, ["EVO4024"]);

  const prefixed = foldDerived(
    [model("morningstar", "ts-60", "TS-60")],
    model("morningstar", "morningstar-ts-60", "Morningstar TS-60", { kind: "charge-controller" }),
    ["Morningstar"],
  );
  assert.equal(prefixed.outcome, "folded");
  assert.equal(prefixed.record.id, "morningstar-ts-60");
  // A held model nothing had classified takes the kind the listings give.
  assert.equal(prefixed.record.kind, "charge-controller");
  assert.deepEqual(prefixed.record.aliases, ["Morningstar TS-60"]);
});

test("a reviewed model reached under another spelling only gains the spelling", () => {
  const reviewed = model("noco", "genius-2d", "Genius 2D", {
    kind: "ac-charger",
    reviewedBy: "lemarier",
    checkedAt: "2026-09-15",
    basis: "Its user guide says it charges 12V lead-acid batteries.",
    dialects: [link("noco-charger-unread")],
  });
  const { record, outcome } = foldDerived(
    [reviewed],
    model("noco", "genius2d", "GENIUS2D", {
      kind: "charge-controller",
      dialects: [link("noco-other")],
    }),
  );
  assert.equal(outcome, "folded");
  assert.deepEqual(record, { ...reviewed, aliases: ["GENIUS2D"] });
});

test("a name no held model answers to is minted, including one of another maker or another variant", () => {
  const held = [
    model("samlex-america", "evo-4024", "EVO-4024"),
    model("victron-energy", "evo2224", "EVO2224"),
  ];
  const derived = model("samlex-america", "evo-2224", "EVO-2224", { kind: "inverter-charger" });
  assert.deepEqual(foldDerived(held, derived), { record: derived, outcome: "added" });
  const voltage = model("samlex-america", "evo-4024-48v", "EVO-4024 48V");
  assert.equal(foldDerived(held, voltage).outcome, "added");
});

test("a model held under the derived id is refreshed, keeps its name and what later steps put on it", () => {
  const battery = model("rolls-battery", "s6-460agm", "S6-460AGM", {
    kind: "battery",
    chemistry: "agm",
    chemistryBasis: "name",
    family: "Series 4000",
    aliases: ["S6 460AGM"],
    dialects: [link("rolls-none")],
  });
  const same = foldDerived(
    [battery],
    model("rolls-battery", "s6-460agm", "S6/460AGM", { aliases: ["S6460AGM", "ROL-1"] }),
  );
  assert.equal(same.outcome, "refreshed");
  // The crawl ran with no classifier, so the kind and the chemistry that comes with it stay, and a
  // spelling that gives the same id is an alias rather than the name.
  assert.deepEqual(same.record, {
    ...battery,
    aliases: ["ROL-1", "S6 460AGM", "S6/460AGM", "S6460AGM"],
  });

  const reclassified = foldDerived(
    [battery],
    model("rolls-battery", "s6-460agm", "S6-460AGM", { kind: "charge-controller" }),
  );
  assert.equal(reclassified.record.kind, "charge-controller");
  assert.equal(reclassified.record.chemistry, undefined);
  assert.equal(reclassified.record.chemistryBasis, undefined);
  assert.equal(reclassified.record.family, "Series 4000");
});

test("a reviewed model held under the derived id keeps everything but gains the new aliases", () => {
  const reviewed = model("epever", "xtra4210n", "XTRA4210N", {
    kind: "charge-controller",
    reviewedBy: "lemarier",
    checkedAt: "2026-09-10",
    basis: "Its manual names it.",
  });
  const { record, outcome } = foldDerived(
    [reviewed],
    model("epever", "xtra4210n", "XTRA 4210N", {
      kind: "inverter",
      aliases: ["EP-1234", "xtra4210n"],
    }),
  );
  assert.equal(outcome, "refreshed");
  // Another case of the name adds nothing; another spacing is kept.
  assert.deepEqual(record, { ...reviewed, aliases: ["EP-1234", "XTRA 4210N"] });
});

test("only the maker's own names come off the front, so another maker's name in front is another product", () => {
  const records = {
    manufacturers: [
      { id: "victron-energy", name: "Victron Energy" },
      { id: "rolls-battery", name: "Rolls Battery" },
    ],
    brands: [
      { brand: "Victron", decision: "manufacturer", manufacturer: "victron-energy" },
      { brand: "Rolls", decision: "manufacturer", manufacturer: "rolls-battery" },
      { brand: "Surrette", decision: "manufacturer", manufacturer: "rolls-battery" },
      { brand: "Lodge", decision: "out-of-scope" },
    ],
  };
  assert.deepEqual(namesOf(records, "rolls-battery"), ["Rolls Battery", "Rolls", "Surrette"]);
  assert.deepEqual(namesOf(records, "nobody"), []);

  // A multi-word part number is reached past a maker's name only; a single code after any words is
  // matchModel's product-line rule, the same for every maker.
  const held = [model("iota-engineering", "ilblp-cp15-he-sd", "ILBLP CP15 HE SD")];
  const iota = {
    ...records,
    manufacturers: [{ id: "iota-engineering", name: "IOTA Engineering" }],
  };
  const own = foldDerived(
    held,
    model("iota-engineering", "iota-ilblp-cp15-he-sd", "IOTA ILBLP CP15 HE SD"),
    namesOf(iota, "iota-engineering"),
  );
  assert.equal(own.outcome, "folded");
  const other = model("iota-engineering", "victron-ilblp-cp15-he-sd", "Victron ILBLP CP15 HE SD");
  assert.equal(foldDerived(held, other, namesOf(iota, "iota-engineering")).outcome, "added");
  assert.equal(
    foldDerived(held, other, ["IOTA Engineering", ...namesOf(records, "victron-energy")]).outcome,
    "folded",
  );
});

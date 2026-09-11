import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brand } from "@origin89/equipment-schema/brand";
import type { Dialect } from "@origin89/equipment-schema/dialect";
import type { Guess } from "@origin89/equipment-schema/guess";
import { Model } from "@origin89/equipment-schema/model";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import {
  deriveModels,
  familyOf,
  familyOfAnotherMaker,
  looksLikeModelName,
  modelId,
  normaliseModelName,
  preferredName,
  productKey,
} from "../src/models.ts";

const brands: Brand[] = [
  {
    id: "epever",
    brand: "EPEver",
    decision: "manufacturer",
    manufacturer: "epever",
    checkedAt: "2026-09-09",
    reviewedBy: "D",
    basis: "x",
    evidence: {
      sellers: ["a"],
      listings: 1,
      inScope: 1,
      kinds: [],
      models: [],
      proposed: [],
      examples: [],
      seenAt: "2026-09-09",
    },
  },
  {
    id: "lodge",
    brand: "Lodge",
    decision: "out-of-scope",
    reason: "cookware",
    checkedAt: "2026-09-09",
    reviewedBy: "D",
    basis: "cookware",
    evidence: {
      sellers: ["a"],
      listings: 1,
      inScope: 0,
      kinds: [],
      models: [],
      proposed: [],
      examples: [],
      seenAt: "2026-09-09",
    },
  },
  {
    id: "mystery",
    brand: "Mystery",
    decision: "unresolved",
    evidence: {
      sellers: ["a"],
      listings: 1,
      inScope: 1,
      kinds: [],
      models: [],
      proposed: [],
      examples: [],
      seenAt: "2026-09-09",
    },
  },
];
const dialects: Dialect[] = [
  {
    id: "epever-tracer-a",
    family: "modbus-rs485",
    driver: { status: "possible" },
    confidence: "vendor-doc",
    refuter: "checked",
    sources: [{ source: "s", citation: "c" }],
    models: [{ name: "XTRA4210N" }],
  },
];
const s = (
  brand: string,
  model: string | undefined,
  sku?: string,
  extra: Partial<Sighting> = {},
): Sighting => ({
  seller: "a",
  productId: `${brand}-${model ?? sku}`,
  handle: "h",
  url: "https://a.example/p",
  title: "t",
  brand,
  currency: "CAD",
  checkedAt: "2026-09-09",
  extractor: "shopify-feed",
  ...(model ? { model } : {}),
  ...(sku ? { sku } : {}),
  ...extra,
});
const derive = (sightings: Sighting[], guesses: Map<string, Guess> = new Map()) =>
  deriveModels({ sightings, guesses, brands, dialects });

test("a listing becomes a model only when its brand resolves to a maker", () => {
  const got = derive([s("EPEver", "XTRA4210N"), s("Mystery", "ZZ-100"), s("Nobody", "QQ-9")]);
  assert.deepEqual(
    got.map((g) => g.model.id),
    ["epever-xtra4210n"],
  );
  assert.equal(got[0].model.manufacturer, "epever");
  Model.parse(got[0].model);
});

test("a model named in a dialect's table is linked to it, carrying the catalogue's own claim", () => {
  const [got] = derive([s("EPEver", "XTRA4210N")]);
  assert.deepEqual(got.model.dialects, ["epever-tracer-a"]);
  const [other] = derive([s("EPEver", "XTRA9999Z")]);
  assert.deepEqual(
    other.model.dialects,
    [],
    "a model the catalogue does not list is not put on a dialect",
  );
});

test("transcription damage is stripped without changing the name", () => {
  assert.equal(normaliseModelName("CC-USB-RS485-150U”,"), "CC-USB-RS485-150U");
  assert.equal(normaliseModelName("  MNEDC250  "), "MNEDC250");
  assert.equal(normaliseModelName("PV-AZS4 &amp; PV-AZB4"), "PV-AZS4 & PV-AZB4");
});

test("a sentence is not a model name, which is what keeps this from being a copy of the shop", () => {
  assert.equal(looksLikeModelName("XTRA4210N"), true);
  assert.equal(looksLikeModelName("SmartSolar MPPT 100/30"), true);
  assert.equal(looksLikeModelName("S-550"), true);
  assert.equal(looksLikeModelName("Estate Lawn Seed 25 lbs"), false);
  assert.equal(looksLikeModelName("Bundle of 32 - 275 Watt Poly Panel"), false);
  assert.equal(looksLikeModelName("Pallet of Bifacial Solar Panels"), false);
  assert.equal(looksLikeModelName("Default Title"), false);
  assert.equal(looksLikeModelName("100W"), false);
  assert.equal(looksLikeModelName("12V"), false);
  assert.equal(looksLikeModelName("a"), false);
});

test("a purely numeric name is kept, because Blue Sea and Wöhner really do number products that way", () => {
  assert.equal(looksLikeModelName("2719"), true);
  assert.equal(looksLikeModelName("31110.000"), true);
  assert.equal(looksLikeModelName("00-10041-450"), true);
  assert.equal(looksLikeModelName("Slow-Release Lawn Fertilizer 20kg"), false);
});

test("a listing classified out of scope contributes nothing, because a skillet has a SKU too", () => {
  const guesses = new Map<string, Guess>([
    [
      "a/EPEver-CAST-IRON-12",
      { seller: "a", productId: "EPEver-CAST-IRON-12", kind: "out-of-scope", by: "ai:@cf/x@p1" },
    ],
  ]);
  assert.deepEqual(derive([s("EPEver", "CAST-IRON-12")], guesses), []);
});

test("a model nothing classified has no kind, rather than a default that reads like a fact", () => {
  const [got] = derive([s("EPEver", "XTRA4210N")]);
  assert.equal(got.model.kind, undefined);
  Model.parse(got.model);
});

test("the kind is what most classifiers agreed on, so one odd answer does not decide it", () => {
  const listings = [
    s("EPEver", "XTRA4210N", undefined, { productId: "p1" }),
    s("EPEver", "XTRA4210N", undefined, { productId: "p2" }),
    s("EPEver", "XTRA4210N", undefined, { productId: "p3" }),
  ];
  const guesses = new Map<string, Guess>([
    ["a/p1", { seller: "a", productId: "p1", kind: "charge-controller", by: "ai:@cf/x@p1" }],
    ["a/p2", { seller: "a", productId: "p2", kind: "charge-controller", by: "ai:@cf/x@p1" }],
    ["a/p3", { seller: "a", productId: "p3", kind: "inverter", by: "ai:@cf/x@p1" }],
  ]);
  const [got] = derive(listings, guesses);
  assert.equal(got.model.kind, "charge-controller");
  assert.equal(got.listings, 3);
});

test("the maker's model field wins over the shop's SKU, and the SKU is kept as an alias", () => {
  const [got] = derive([s("EPEver", "XTRA4210N", "EP-1234")]);
  assert.equal(got.model.name, "XTRA4210N");
  assert.deepEqual(got.model.aliases, ["EP-1234"]);
});

test("a listing with only a SKU still yields a model, since many shops carry no model field", () => {
  const [got] = derive([s("EPEver", undefined, "MT50")]);
  assert.equal(got.model.name, "MT50");
});

test("a derived model carries no reviewer, because nothing has checked it against a document", () => {
  const [got] = derive([s("EPEver", "XTRA4210N")]);
  assert.equal(got.model.reviewedBy, undefined);
  assert.equal(got.model.basis, undefined);
});

test("ids are unique per maker and stable across runs", () => {
  assert.equal(modelId("epever", "XTRA4210N"), "epever-xtra4210n");
  assert.equal(
    modelId("victron-energy", "SmartSolar MPPT 100/30"),
    "victron-energy-smartsolar-mppt-100-30",
  );
  assert.notEqual(modelId("epever", "X-1"), modelId("victron-energy", "X-1"));
});

test("a rating is not a model name, including a parenthesised conversion", () => {
  // Rolls publishes capacity against temperature: columns "40°C (104°F)", row "102%". Every one of
  // them passed as a model while the page's entities were left undecoded and read as "40&deg;C".
  assert.equal(looksLikeModelName("40°C (104°F)"), false);
  assert.equal(looksLikeModelName("102%"), false);
  assert.equal(looksLikeModelName("25 °C"), false);
});

test("a catalogue number made only of digits is still a model, since Blue Sea and Wöhner name products that way", () => {
  assert.equal(looksLikeModelName("2719"), true);
  assert.equal(looksLikeModelName("31110.000"), true);
  assert.equal(looksLikeModelName("S12-90GEL"), true);
});

test("a maker's own name and a seller's descriptor do not make a second product", () => {
  // Three records for one EG4, and four for the 12kPV, because each source wrote the name its way.
  const key = (name: string) => productKey("EG4 Electronics", name);
  assert.equal(key("6000XP"), key("EG4 6000xp"));
  assert.equal(key("12kPV"), key("EG4 12kPV Inverter"));
  // "PVEG4 6000XP Inverter" does not join them, and deliberately so. Stripping "eg4" out of the
  // middle of a word a seller invented leaves "pv", and reaching further to make it match is how a
  // rule starts merging products that differ. A missed duplicate is one somebody can still see; a
  // wrong merge deletes a product and takes its figures with it.
  assert.notEqual(key("6000XP"), key("PVEG4 6000XP Inverter"));
  const outback = (name: string) => productKey("OutBack Power", name);
  assert.equal(outback("OBX-IC2024S-120/60"), outback("OBX-IC2024S-120/60 Inverter/Charger"));
});

test("punctuation inside a part number does not make a second product either", () => {
  // Fronius writes the same part number with and without thousands separators.
  assert.equal(productKey("Fronius", "4,210,052,841"), productKey("Fronius", "4210052841"));
  assert.equal(productKey("Morningstar", "TS-45"), productKey("Morningstar", "TS45"));
  assert.equal(productKey("Samlex America", "EVO-1212F"), productKey("Samlex America", "EVO1212F"));
});

test("two genuinely different products keep their own records", () => {
  // A bundle is not the inverter inside it, and a 6000XP is not a 12kPV.
  assert.notEqual(
    productKey("EG4 Electronics", "6000XP"),
    productKey("EG4 Electronics", "EG4RX-6000XP-BDL1"),
  );
  assert.notEqual(productKey("EG4 Electronics", "6000XP"), productKey("EG4 Electronics", "12kPV"));
  assert.notEqual(
    productKey("MidNite Solar", "CLASSIC 150"),
    productKey("MidNite Solar", "CLASSIC 250"),
  );
  assert.notEqual(productKey("Sol-Ark", "15K-2P-LV"), productKey("Sol-Ark", "15K-2P-N"));
});

test("the name kept is the maker's, and the seller's becomes an alias", () => {
  assert.equal(preferredName(["PVEG4 6000XP Inverter", "6000XP", "EG4 6000xp"]), "6000XP");
  assert.equal(preferredName(["Sol-Ark 12K-2P-N", "12K-2P-N", "Sol-Ark12K-2P-N"]), "12K-2P-N");
});

test("a name's family is the word it leads with, unless that word is anybody's", () => {
  assert.equal(familyOf("MultiPlus-II 48/3000/35-50"), "multiplus-ii");
  assert.equal(familyOf("SmartSolar MPPT 100/20"), "smartsolar");
  assert.equal(familyOf("MultiPlus-II/48/3000"), "multiplus-ii", "a slash ends the word too");
  assert.equal(familyOf("12/3000/120-50"), undefined, "a bank voltage is nobody's family");
  assert.equal(familyOf("12V LiFePO4 Battery"), undefined, "nor is a rating");
  assert.equal(familyOf("2x120 V 12/3000"), undefined);
  assert.equal(familyOf("MPPT 150/45"), undefined, "nor is a technology");
  assert.equal(familyOf("Inverter Charger 3000"), undefined, "nor what a thing is");
  assert.equal(familyOf("C35"), "c35", "a short code still leads a range");
  assert.equal(familyOf("GX"), undefined, "two letters do not");
  assert.equal(familyOf("(MultiPlus-II) 48/3000"), "multiplus-ii", "brackets are not the word");
  assert.equal(familyOf('"SmartSolar" MPPT'), "smartsolar");
  assert.equal(familyOf("(12V) battery"), undefined, "nor do they make a rating a family");
  assert.equal(familyOf("()"), undefined);
  assert.equal(familyOf(""), undefined);
});

/** A maker's models, named so each leads with the family given. */
const family = (manufacturer: string, names: string[]): Model[] =>
  names.map((name) => ({
    id: modelId(manufacturer, name),
    manufacturer,
    name,
    aliases: [],
    dialects: [],
  }));

const held: Model[] = [
  ...family("victron-energy", [
    "MultiPlus-II 48/3000/35-32 GX",
    "MultiPlus-II 48/5000/70-50 GX",
    "MPPT 150/45",
    "MPPT 100/20",
  ]),
  ...family("xantrex", [
    "MPPT 60-150",
    "MPPT 80-600",
    "Xantrex IP1012 AL",
    "Freedom XC 2000",
    "Freedom XC 1000",
  ]),
  ...family("morningstar", ["RTS"]),
  ...family("rolls-battery", ["S-550", "S48-100LFP STACK-LV"]),
  ...family("pentair", ["Cap Regulated Injector 20 PSI", "Cap Regulated Injector 30 PSI"]),
  ...family("eg4-electronics", ["EG4 6000XP", "EG4 18kPV"]),
];
const makerNames = [
  "Victron Energy",
  "Xantrex",
  "Morningstar",
  "Rolls Battery",
  "Pentair",
  "EG4 Electronics",
  "EG4",
];

test("a product named after another maker's family is that maker's, with the maker's own name in front or not (#86)", () => {
  const victron = { family: "multiplus-ii", manufacturer: "victron-energy" };
  assert.deepEqual(
    familyOfAnotherMaker(held, "rolls-battery", "MultiPlus-II 48/3000/35-50"),
    victron,
  );
  assert.deepEqual(
    familyOfAnotherMaker(
      held,
      "rolls-battery",
      "Victron MultiPlus-II GX 48/3000/35-32",
      makerNames,
    ),
    victron,
    "the maker's own name in front does not hide the family",
  );
  assert.deepEqual(
    familyOfAnotherMaker(
      held,
      "rolls-battery",
      "Victron Energy MultiPlus-II 48/3000/35-32",
      makerNames,
    ),
    victron,
    "nor does a two-word one",
  );
  assert.deepEqual(
    familyOfAnotherMaker(held, "rolls-battery", "Victron (MultiPlus-II) 48/3000/35-32", makerNames),
    victron,
    "nor do the brackets a document wraps it in",
  );
  assert.deepEqual(
    familyOfAnotherMaker(held, "rolls-battery", "multiplus-ii 230V"),
    victron,
    "case and spacing do not matter",
  );
  assert.deepEqual(
    familyOfAnotherMaker(held, "sol-ark", "EG4 6000XP", makerNames),
    { family: "eg4", manufacturer: "eg4-electronics" },
    "a maker's name that also leads its products is the family, not a word to drop",
  );
  assert.deepEqual(
    familyOfAnotherMaker(held, "rolls-battery", "Xantrex Freedom XC 2000", makerNames),
    { family: "freedom", manufacturer: "xantrex" },
    "a maker's name that leads one of its models is still dropped, and the family behind it read",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "Xantrex IP1012 AL", makerNames),
    undefined,
    "a single model behind the maker's name is a product, not a family",
  );
});

test("only the word a name leads with can claim a family", () => {
  assert.equal(
    familyOfAnotherMaker(held, "apsystems", "AC Bus Drop Cap", makerNames),
    undefined,
    "Pentair's injectors lead with Cap; a cap at the end of a name is not theirs",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "Victron MultiPlus-II 48/3000/35-50"),
    undefined,
    "without the makers' names, a name that leads with one claims nothing",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "S-550 for the MultiPlus-II"),
    undefined,
  );
});

test("a maker's own family, a shared word, and a new family are all still its own to mint", () => {
  assert.equal(
    familyOfAnotherMaker(held, "victron-energy", "MultiPlus-II 24/3000/70-32 230V"),
    undefined,
    "Victron naming a new MultiPlus-II variant is Victron's",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "MPPT 60-150"),
    undefined,
    "a word two makers lead with is nobody's family",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "RTS"),
    undefined,
    "one model is a product, not a family",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "S48-300LFP STACK-LV"),
    undefined,
    "a maker's new product in its own range",
  );
  assert.equal(
    familyOfAnotherMaker(held, "rolls-battery", "48/3000/35-50"),
    undefined,
    "a name that leads with a number claims no family",
  );
  assert.equal(familyOfAnotherMaker([], "rolls-battery", "MultiPlus-II 48/3000"), undefined);
});

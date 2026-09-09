import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveModels, looksLikeModelName, modelId, normaliseModelName } from "../src/models.ts";
import { Model } from "../schema/model.ts";
import type { Brand } from "../schema/brand.ts";
import type { Sighting } from "../schema/sighting.ts";
import type { Guess } from "../schema/guess.ts";
import type { Dialect } from "../schema/dialect.ts";

const brands: Brand[] = [
  { id: "epever", brand: "EPEver", decision: "manufacturer", manufacturer: "epever", checkedAt: "2026-09-09", reviewedBy: "D", basis: "x", evidence: { sellers: ["a"], listings: 1, inScope: 1, kinds: [], models: [], proposed: [], examples: [], seenAt: "2026-09-09" } },
  { id: "lodge", brand: "Lodge", decision: "out-of-scope", reason: "cookware", checkedAt: "2026-09-09", reviewedBy: "D", basis: "cookware", evidence: { sellers: ["a"], listings: 1, inScope: 0, kinds: [], models: [], proposed: [], examples: [], seenAt: "2026-09-09" } },
  { id: "mystery", brand: "Mystery", decision: "unresolved", evidence: { sellers: ["a"], listings: 1, inScope: 1, kinds: [], models: [], proposed: [], examples: [], seenAt: "2026-09-09" } },
];
const dialects: Dialect[] = [
  { id: "epever-tracer-a", family: "modbus-rs485", driver: { status: "possible" }, confidence: "vendor-doc", refuter: "checked", sources: [{ source: "s", citation: "c" }], models: [{ name: "XTRA4210N" }] },
];
const s = (brand: string, model: string | undefined, sku?: string, extra: Partial<Sighting> = {}): Sighting => ({
  seller: "a", productId: `${brand}-${model ?? sku}`, handle: "h", url: "https://a.example/p", title: "t", brand, currency: "CAD", checkedAt: "2026-09-09", extractor: "shopify-feed",
  ...(model ? { model } : {}), ...(sku ? { sku } : {}), ...extra,
});
const derive = (sightings: Sighting[], guesses: Map<string, Guess> = new Map()) => deriveModels({ sightings, guesses, brands, dialects });

test("a listing becomes a model only when its brand resolves to a maker", () => {
  const got = derive([s("EPEver", "XTRA4210N"), s("Mystery", "ZZ-100"), s("Nobody", "QQ-9")]);
  assert.deepEqual(got.map((g) => g.model.id), ["epever-xtra4210n"]);
  assert.equal(got[0].model.manufacturer, "epever");
  Model.parse(got[0].model);
});

test("a model named in a dialect's table is linked to it, carrying the catalogue's own claim", () => {
  const [got] = derive([s("EPEver", "XTRA4210N")]);
  assert.deepEqual(got.model.dialects, ["epever-tracer-a"]);
  const [other] = derive([s("EPEver", "XTRA9999Z")]);
  assert.deepEqual(other.model.dialects, [], "a model the catalogue does not list is not put on a dialect");
});

test("transcription damage is stripped without changing the name", () => {
  assert.equal(normaliseModelName('CC-USB-RS485-150U”,'), "CC-USB-RS485-150U");
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
  const guesses = new Map<string, Guess>([["a/EPEver-CAST-IRON-12", { seller: "a", productId: "EPEver-CAST-IRON-12", kind: "out-of-scope", by: "ai:@cf/x@p1" }]]);
  assert.deepEqual(derive([s("EPEver", "CAST-IRON-12")], guesses), []);
});

test("a model nothing classified has no kind, rather than a default that reads like a fact", () => {
  const [got] = derive([s("EPEver", "XTRA4210N")]);
  assert.equal(got.model.kind, undefined);
  Model.parse(got.model);
});

test("the kind is what most classifiers agreed on, so one odd answer does not decide it", () => {
  const listings = [s("EPEver", "XTRA4210N", undefined, { productId: "p1" }), s("EPEver", "XTRA4210N", undefined, { productId: "p2" }), s("EPEver", "XTRA4210N", undefined, { productId: "p3" })];
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
  assert.equal(modelId("victron-energy", "SmartSolar MPPT 100/30"), "victron-energy-smartsolar-mppt-100-30");
  assert.notEqual(modelId("epever", "X-1"), modelId("victron-energy", "X-1"));
});

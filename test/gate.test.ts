import assert from "node:assert/strict";
import { test } from "node:test";
import { Brand } from "@origin89/equipment-schema/brand";
import type { Guess } from "@origin89/equipment-schema/guess";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import { brandId, gatherBrands, mergeBrand, resolveBrand } from "../src/gate.ts";

const s = (
  seller: string,
  productId: string,
  brand: string,
  title: string,
  model?: string,
): Sighting => ({
  seller,
  productId,
  handle: productId,
  url: `https://${seller}.example/p/${productId}`,
  title,
  brand,
  currency: "CAD",
  checkedAt: "2026-09-09",
  extractor: "shopify-feed",
  ...(model ? { model } : {}),
});
const g = (
  seller: string,
  productId: string,
  kind: Guess["kind"],
  extra: Partial<Guess> = {},
): [string, Guess] => [
  `${seller}/${productId}`,
  { seller, productId, kind, by: "ai:@cf/test@p1", ...extra },
];

test("a brand string becomes a stable id, whatever punctuation the seller printed", () => {
  assert.equal(brandId("Rolls/Surrette"), "rolls-surrette");
  assert.equal(brandId("EP Solar"), "ep-solar");
  assert.equal(brandId("  Victron Energy  "), "victron-energy");
  assert.equal(brandId("Énergie"), "energie");
  assert.equal(brandId("!!!"), "unnamed");
});

test("brands are ranked by in-scope listings, so the reviewer meets the charge controllers before the skillets", () => {
  const sightings = [
    s("a", "1", "Lodge", "Cast iron skillet"),
    s("a", "2", "Lodge", "Dutch oven"),
    s("a", "3", "EPEver", "XTRA4210N MPPT"),
  ];
  const guesses = new Map([
    g("a", "1", "out-of-scope"),
    g("a", "2", "out-of-scope"),
    g("a", "3", "charge-controller", { model: "XTRA4210N" }),
  ]);
  const rows = gatherBrands({ sightings, guesses, seenAt: "2026-09-09" });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["epever", "lodge"],
  );
  assert.equal(rows[0].evidence.inScope, 1);
  assert.equal(rows[1].evidence.inScope, 0);
  assert.deepEqual(rows[0].evidence.models, ["XTRA4210N"]);
});

test("one brand seen at two sellers is one queue entry naming both", () => {
  const rows = gatherBrands({
    sightings: [s("a", "1", "Victron", "MPPT"), s("b", "9", "Victron", "Shunt")],
    guesses: new Map(),
    seenAt: "2026-09-09",
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].evidence.sellers, ["a", "b"]);
  assert.equal(rows[0].evidence.listings, 2);
});

test("a listing with no brand is not a brand called empty", () => {
  const rows = gatherBrands({
    sightings: [{ ...s("a", "1", "x", "t"), brand: undefined }],
    guesses: new Map(),
    seenAt: "2026-09-09",
  });
  assert.deepEqual(rows, []);
});

test("a decision survives a later crawl, and the fresh evidence replaces the stale counts", () => {
  const decided = Brand.parse({
    id: "epever",
    brand: "EPEver",
    decision: "manufacturer",
    manufacturer: "epever",
    checkedAt: "2026-09-01",
    reviewedBy: "David",
    evidence: {
      sellers: ["a"],
      listings: 1,
      inScope: 1,
      kinds: ["charge-controller 1"],
      models: ["XTRA4210N"],
      proposed: [],
      examples: ["old title"],
      seenAt: "2026-09-01",
    },
  });
  const merged = mergeBrand(decided, {
    id: "epever",
    brand: "EPEver",
    evidence: {
      sellers: ["b"],
      listings: 9,
      inScope: 8,
      kinds: ["charge-controller 8"],
      models: ["XTRA3215N"],
      proposed: [],
      examples: ["new title"],
      seenAt: "2026-09-09",
    },
  });
  assert.equal(merged.decision, "manufacturer");
  assert.equal(merged.reviewedBy, "David");
  assert.equal(merged.evidence.listings, 9);
  assert.deepEqual(merged.evidence.sellers, ["a", "b"]);
  assert.ok(
    merged.evidence.models.includes("XTRA3215N") && merged.evidence.models.includes("XTRA4210N"),
  );
  assert.equal(merged.evidence.seenAt, "2026-09-09");
  Brand.parse(merged);
});

test("a brand new to the queue arrives unresolved, never pre-answered from a model's proposal", () => {
  const fresh = mergeBrand(undefined, {
    id: "ep-solar",
    brand: "EP Solar",
    evidence: {
      sellers: ["a"],
      listings: 4,
      inScope: 4,
      kinds: ["charge-controller 4"],
      models: ["XTRA2210N"],
      proposed: ["EPEver"],
      examples: [],
      seenAt: "2026-09-09",
    },
  });
  assert.equal(fresh.decision, "unresolved");
  assert.equal(fresh.manufacturer, undefined);
  assert.deepEqual(
    fresh.evidence.proposed,
    ["EPEver"],
    "the proposal is evidence for the reviewer, not the answer",
  );
  Brand.parse(fresh);
});

test("only a decided brand resolves, so an unreviewed string reaches no manufacturer", () => {
  const brands = [
    Brand.parse({
      id: "epever",
      brand: "EPEver",
      decision: "manufacturer",
      manufacturer: "epever",
      checkedAt: "2026-09-01",
      reviewedBy: "D",
      evidence: {
        sellers: ["a"],
        listings: 1,
        inScope: 1,
        kinds: [],
        models: [],
        proposed: [],
        examples: [],
        seenAt: "2026-09-01",
      },
    }),
    Brand.parse({
      id: "lodge",
      brand: "Lodge",
      decision: "out-of-scope",
      reason: "cookware",
      checkedAt: "2026-09-01",
      reviewedBy: "D",
      evidence: {
        sellers: ["a"],
        listings: 1,
        inScope: 0,
        kinds: [],
        models: [],
        proposed: [],
        examples: [],
        seenAt: "2026-09-01",
      },
    }),
    Brand.parse({
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
        seenAt: "2026-09-01",
      },
    }),
  ];
  assert.equal(resolveBrand(brands, "EPEver"), "epever");
  assert.equal(resolveBrand(brands, "Lodge"), undefined);
  assert.equal(resolveBrand(brands, "Mystery"), undefined);
  assert.equal(resolveBrand(brands, "Never seen"), undefined);
  assert.equal(resolveBrand(brands, undefined), undefined);
});

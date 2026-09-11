import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LIMITS, SourcesQuery } from "@origin89/equipment-api";
import { loadPartName } from "@origin89/equipment-schema/releases";
import {
  bundle,
  currentRelease,
  loadedRelease,
  properties,
  releaseInfo,
  resolve,
  search,
  sourcesById,
} from "../src/equipment-api.ts";
import { loadRelease, type Steps } from "../src/release-load.ts";
import { forget } from "../src/release-store.ts";
import { loadKey, releaseKey } from "../src/releases.ts";
import { world } from "./world.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plain: Steps = { do: (_name, fn) => fn() };
const RELEASE = "a".repeat(64);
const OLDER = "b".repeat(64);

/** A small release the way the build would publish it, loaded into a fresh world. */
async function fixture(
  extra: Record<string, Record<string, unknown>[]> = {},
  id = RELEASE,
  at = "2026-09-11T10:00:00Z",
) {
  const model = (over: Record<string, unknown>) => ({
    tier: "record",
    manufacturer_id: "victron-energy",
    manufacturer_name: "Victron Energy",
    kind: "charge-controller",
    ...over,
  });
  const tables: Record<string, Record<string, unknown>[]> = {
    manufacturers: [
      { id: "victron-energy", name: "Victron Energy" },
      { id: "epever", name: "EPEver (Beijing Epsolar Technology)" },
      { id: "sol-ark", name: "Sol-Ark" },
    ],
    brands: [
      {
        id: "victron",
        brand: "Victron",
        decision: "manufacturer",
        manufacturer_id: "victron-energy",
      },
      { id: "nobody", brand: "Nobody", decision: "out-of-scope" },
    ],
    models: [
      model({
        id: "victron-energy-smartsolar-mppt-150-35",
        name: "SmartSolar MPPT 150/35",
        reviewed_by: "ada",
      }),
      model({ id: "victron-energy-smartsolar-mppt-150-45", name: "SmartSolar MPPT 150/45" }),
      model({
        id: "victron-energy-multiplus-ii-48-3000",
        name: "MultiPlus-II 48/3000",
        kind: "inverter-charger",
      }),
      model({
        id: "epever-xtra4210n",
        manufacturer_id: "epever",
        manufacturer_name: "EPEver (Beijing Epsolar Technology)",
        name: "XTRA4210N",
      }),
      model({
        id: "sol-ark-12k",
        manufacturer_id: "sol-ark",
        manufacturer_name: "Sol-Ark",
        name: "12K",
        kind: "inverter",
      }),
      model({
        id: "sol-ark-sol-ark-12k",
        manufacturer_id: "sol-ark",
        manufacturer_name: "Sol-Ark",
        name: "Sol-Ark 12K",
        kind: "inverter",
      }),
      {
        id: "sam-cec-acme-i-3000",
        tier: "feed",
        manufacturer_name: "Acme",
        name: "I-3000",
        kind: "inverter",
      },
    ],
    model_aliases: [{ model_id: "victron-energy-smartsolar-mppt-150-35", alias: "SCC115035210" }],
    model_keys: [
      {
        model_id: "victron-energy-smartsolar-mppt-150-35",
        key: "victronenergysmartsolarmppt150/35",
        name_key: "smartsolarmppt150/35",
        label: "Victron Energy",
        via: "name",
      },
      {
        model_id: "victron-energy-smartsolar-mppt-150-35",
        key: "victronsmartsolarmppt150/35",
        name_key: "smartsolarmppt150/35",
        label: "Victron",
        via: "name",
      },
      {
        model_id: "victron-energy-smartsolar-mppt-150-35",
        key: "victronenergyscc115035210",
        name_key: "scc115035210",
        label: "Victron Energy",
        via: "alias",
      },
      {
        model_id: "victron-energy-smartsolar-mppt-150-45",
        key: "victronenergysmartsolarmppt150/45",
        name_key: "smartsolarmppt150/45",
        label: "Victron Energy",
        via: "name",
      },
      {
        model_id: "victron-energy-multiplus-ii-48-3000",
        key: "victronenergymultiplusii48/3000",
        name_key: "multiplusii48/3000",
        label: "Victron Energy",
        via: "name",
      },
      {
        model_id: "epever-xtra4210n",
        key: "epeverxtra4210n",
        name_key: "xtra4210n",
        label: "EPEver (Beijing Epsolar Technology)",
        via: "name",
      },
      { model_id: "sol-ark-12k", key: "solark12k", name_key: "12k", label: "Sol-Ark", via: "name" },
      {
        model_id: "sol-ark-sol-ark-12k",
        key: "solark12k",
        name_key: "12k",
        label: "Sol-Ark",
        via: "name",
      },
      {
        model_id: "sam-cec-acme-i-3000",
        key: "acmei3000",
        name_key: "i3000",
        label: "Acme",
        via: "name",
      },
    ],
    specs: [
      {
        id: "victron-energy-smartsolar-mppt-150-35--max-pv-voltage",
        tier: "record",
        model_id: "victron-energy-smartsolar-mppt-150-35",
        name: "Maximum PV open circuit voltage",
        value: "150",
        unit: "V",
        source_id: "doc-victron-150-35",
        page: 2,
        confidence: "vendor-doc",
        extracted_by: "ai:@cf/test@p1",
        reviewed_by: "ada",
      },
      {
        id: "victron-energy-smartsolar-mppt-150-35--charge-current",
        tier: "record",
        model_id: "victron-energy-smartsolar-mppt-150-35",
        name: "Rated charge current",
        value: "35",
        unit: "A",
        source_id: "doc-victron-150-35",
        page: 2,
        confidence: "vendor-doc",
        extracted_by: "ai:@cf/test@p1",
        doubt: "the unit was inferred",
      },
      {
        id: "epever-xtra4210n--rated-current",
        tier: "record",
        model_id: "epever-xtra4210n",
        name: "Rated charge current",
        value: "40",
        unit: "A",
        source_id: "doc-epever-xtra",
        confidence: "vendor-doc",
        extracted_by: "ai:@cf/test@p1",
      },
      {
        id: "sam-cec-acme-i-3000--00-paco",
        tier: "feed",
        model_id: "sam-cec-acme-i-3000",
        name: "Maximum AC power output",
        value: "3000",
        unit: "W",
        source_id: "sam-cec",
        confidence: "vendor-doc",
      },
    ],
    dialects: [
      {
        id: "victron-mppt-vedirect-hex",
        family: "vedirect",
        manufacturer: "victron-energy",
        confidence: "vendor-doc",
        refuter: "refuted",
        transport: "VE.Direct, 19200 8N1",
        blocks: "HEX registers 0xEDDC…",
      },
      {
        id: "epever-xtra-n-g3",
        family: "modbus-rtu",
        manufacturer: "epever",
        confidence: "unverified",
        refuter: "none",
      },
    ],
    dialect_gotchas: [
      {
        dialect_id: "victron-mppt-vedirect-hex",
        position: 0,
        text: "The text protocol drops frames under load.",
      },
      { dialect_id: "victron-mppt-vedirect-hex", position: 1, text: "HEX mode must be asked for." },
    ],
    dialect_sources: [
      {
        dialect_id: "victron-mppt-vedirect-hex",
        position: 0,
        source_id: "doc-vedirect-whitepaper",
        citation: "VE.Direct HEX protocol, section 4",
      },
    ],
    dialect_kinds: [
      {
        dialect_id: "victron-mppt-vedirect-hex",
        direction: "reports",
        position: 0,
        kind: "pv-voltage",
      },
      {
        dialect_id: "victron-mppt-vedirect-hex",
        direction: "accepts",
        position: 0,
        kind: "charge-limit",
      },
    ],
    model_dialects: [
      {
        model_id: "victron-energy-smartsolar-mppt-150-35",
        dialect_id: "victron-mppt-vedirect-hex",
        evidence_kind: "register-match",
        confidence: "vendor-doc",
        firmware_min: "1.61",
      },
      {
        model_id: "epever-xtra4210n",
        dialect_id: "epever-xtra-n-g3",
        evidence_kind: "catalogue-name",
        confidence: "unverified",
      },
    ],
    model_dialect_sources: [
      {
        model_id: "victron-energy-smartsolar-mppt-150-35",
        dialect_id: "victron-mppt-vedirect-hex",
        position: 0,
        source_id: "doc-victron-150-35",
        citation: "VE.Direct port, p. 4",
      },
    ],
    sources: [
      {
        id: "doc-victron-150-35",
        url: "https://www.victronenergy.com/upload/documents/Datasheet-SmartSolar-150-35.pdf",
        sha256: "c".repeat(64),
        retrieved_at: "2026-09-01",
      },
      { id: "doc-epever-xtra", url: "https://www.epever.com/xtra.pdf" },
      {
        id: "doc-vedirect-whitepaper",
        url: "https://www.victronenergy.com/vedirect.pdf",
        redistributable: true,
      },
      { id: "doc-unrelated", url: "https://elsewhere.test/x.pdf" },
    ],
    ...extra,
  };
  const objects: Record<string, string> = {};
  const files: Record<string, { rows: number; bytes: number; sha256: string }> = {};
  const load: { version: 1; tables: Record<string, { parts: string[]; rows: number }> } = {
    version: 1,
    tables: {},
  };
  for (const [table, rows] of Object.entries(tables)) {
    const name = loadPartName(table, 1);
    const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    files[name] = { rows: rows.length, bytes: text.length, sha256: sha256(text) };
    objects[loadKey(sha256(text))] = text;
    load.tables[table] = { parts: rows.length ? [name] : [], rows: rows.length };
  }
  objects[releaseKey(id)] = JSON.stringify({
    id,
    content: sha256(id),
    attempt: "1",
    at,
    sha: "a".repeat(40),
    job: "1",
    files,
    load,
  });
  const w = world(objects);
  const outcome = await loadRelease(w.env.ARCHIVE, w.env.RELEASES, plain, id);
  assert.equal(outcome.outcome, "loaded", JSON.stringify(outcome));
  return { db: w.env.RELEASES, world: w };
}

test("a name resolves to one model under its maker or its brand, and an alias reaches it too", async () => {
  const { db } = await fixture();
  const byMaker = await resolve(db, RELEASE, {
    brand: "Victron Energy",
    model: "SmartSolar MPPT 150/35",
  });
  assert.equal(byMaker.outcome, "exact");
  if (byMaker.outcome === "exact") {
    assert.equal(byMaker.model.id, "victron-energy-smartsolar-mppt-150-35");
    assert.deepEqual(byMaker.model.aliases, ["SCC115035210"]);
    assert.equal(byMaker.model.reviewedBy, "ada");
    assert.deepEqual(byMaker.model.manufacturer, { id: "victron-energy", name: "Victron Energy" });
  }
  const byBrand = await resolve(db, RELEASE, { brand: "victron", model: "smartsolar-mppt 150/35" });
  assert.equal(byBrand.outcome, "exact", "case, spaces and dashes do not matter");
  const byAlias = await resolve(db, RELEASE, { brand: "Victron Energy", model: "SCC115035210" });
  assert.equal(byAlias.outcome, "exact");
  const noBrand = await resolve(db, RELEASE, { model: "XTRA4210N" });
  assert.equal(
    noBrand.outcome,
    "exact",
    "without a brand, the name alone is enough when one model has it",
  );
  const wrongKind = await resolve(db, RELEASE, {
    brand: "Victron Energy",
    model: "SmartSolar MPPT 150/35",
    kind: "inverter",
  });
  assert.equal(wrongKind.outcome, "none", "a kind that does not fit rules the match out");
});

test("a key two models share is ambiguous, never picked, and a miss shows near neighbours", async () => {
  const { db } = await fixture();
  const twice = await resolve(db, RELEASE, { brand: "Sol-Ark", model: "12K" });
  assert.equal(twice.outcome, "ambiguous");
  if (twice.outcome === "ambiguous") {
    assert.deepEqual(twice.candidates.map((c) => c.id).sort(), [
      "sol-ark-12k",
      "sol-ark-sol-ark-12k",
    ]);
    assert.equal(twice.truncated, false);
  }
  const miss = await resolve(db, RELEASE, {
    brand: "Victron Energy",
    model: "SmartSolar MPPT 150/60",
  });
  assert.equal(miss.outcome, "none");
  if (miss.outcome === "none") {
    assert.deepEqual(
      miss.near.map((m) => m.name),
      ["SmartSolar MPPT 150/35", "SmartSolar MPPT 150/45"],
      "neighbours share the start of the name",
    );
    assert.equal(miss.truncated, false);
  }
  const nothing = await resolve(db, RELEASE, { model: "Q" });
  assert.deepEqual(nothing, { outcome: "none", near: [], truncated: false });
});

test("a label read off a device resolves whether or not the maker is printed on it", async () => {
  const { db } = await fixture();
  const reversed = await resolve(db, RELEASE, { label: "SmartSolar MPPT 150/35 Victron Energy" });
  assert.equal(reversed.outcome, "exact", "a label that prints the model before the maker");
  for (const label of [
    "Victron Energy SmartSolar MPPT 150/35",
    "SmartSolar MPPT 150/35",
    "VICTRON SMARTSOLAR MPPT 150/35",
    "Victron Energy BlueSolar SmartSolar MPPT 150/35",
  ]) {
    const found = await resolve(db, RELEASE, { label });
    assert.equal(found.outcome, "exact", label);
    if (found.outcome === "exact")
      assert.equal(found.model.id, "victron-energy-smartsolar-mppt-150-35");
  }
  const short = await resolve(db, RELEASE, { label: "12K" });
  assert.equal(
    short.outcome,
    "ambiguous",
    "a label two models share is ambiguous like any other key",
  );
  const unknown = await resolve(db, RELEASE, { label: "Zeta Q9" });
  assert.equal(unknown.outcome, "none");
});

test("search pages by name within a maker, a brand, a prefix or a kind, and says when it was cut", async () => {
  const { db } = await fixture();
  const victron = await search(db, RELEASE, { brand: "Victron", limit: 2 });
  assert.deepEqual(
    victron.items.map((m) => m.name),
    ["MultiPlus-II 48/3000", "SmartSolar MPPT 150/35"],
  );
  assert.equal(victron.truncated, true);
  assert.ok(victron.cursor);
  const rest = await search(db, RELEASE, { brand: "Victron", limit: 2, cursor: victron.cursor });
  assert.deepEqual(
    rest.items.map((m) => m.name),
    ["SmartSolar MPPT 150/45"],
  );
  assert.equal(rest.truncated, false);
  assert.equal(rest.cursor, undefined);
  const controllers = await search(db, RELEASE, {
    brand: "Victron Energy",
    kind: "charge-controller",
    limit: 10,
  });
  assert.equal(controllers.items.length, 2);
  const prefix = await search(db, RELEASE, { prefix: "smartsolar mppt 150", limit: 10 });
  assert.equal(prefix.items.length, 2);
  const feed = await search(db, RELEASE, { brand: "Acme", limit: 10 });
  assert.deepEqual(
    feed.items.map((m) => [m.id, m.tier, m.manufacturer]),
    [["sam-cec-acme-i-3000", "feed", { name: "Acme" }]],
    "a feed row is found by the name it prints",
  );
  assert.deepEqual(await search(db, RELEASE, { brand: "Nobody", limit: 10 }), {
    items: [],
    truncated: false,
  });
  await assert.rejects(
    search(db, RELEASE, { brand: "Victron", limit: 2, cursor: "made up" }),
    /not a cursor/,
  );
});

test("a bundle carries the models, their claims, their protocol links and exactly the sources those cite", async () => {
  const { db } = await fixture();
  const out = await bundle(db, RELEASE, {
    models: ["victron-energy-smartsolar-mppt-150-35", "epever-xtra4210n", "no-such-model"],
    properties: ["pv.voc.max"],
  });
  assert.equal(out.release, RELEASE);
  assert.deepEqual(
    out.models.map((m) => m.id),
    ["victron-energy-smartsolar-mppt-150-35", "epever-xtra4210n"],
  );
  assert.deepEqual(out.unknown, ["no-such-model"]);
  assert.deepEqual(
    out.claims.map((c) => [c.model, c.name, c.value, c.unit, c.page, c.reviewedBy, c.doubt]),
    [
      ["epever-xtra4210n", "Rated charge current", "40", "A", undefined, undefined, undefined],
      [
        "victron-energy-smartsolar-mppt-150-35",
        "Rated charge current",
        "35",
        "A",
        2,
        undefined,
        "the unit was inferred",
      ],
      [
        "victron-energy-smartsolar-mppt-150-35",
        "Maximum PV open circuit voltage",
        "150",
        "V",
        2,
        "ada",
        undefined,
      ],
    ],
  );
  assert.deepEqual(
    out.protocol.map((p) => [p.evidence, p.confidence, p.firmware]),
    [
      [{ kind: "catalogue-name", sources: [] }, "unverified", undefined],
      [
        {
          kind: "register-match",
          sources: [{ source: "doc-victron-150-35", citation: "VE.Direct port, p. 4" }],
        },
        "vendor-doc",
        { min: "1.61" },
      ],
    ],
    "a link says how it was made, and its citation is among the bundle's sources",
  );
  assert.deepEqual(
    out.protocol.map((p) => [
      p.model,
      p.dialect.id,
      p.dialect.confidence,
      p.dialect.gotchas.length,
      p.dialect.reports,
      p.dialect.accepts,
    ]),
    [
      ["epever-xtra4210n", "epever-xtra-n-g3", "unverified", 0, [], []],
      [
        "victron-energy-smartsolar-mppt-150-35",
        "victron-mppt-vedirect-hex",
        "vendor-doc",
        2,
        ["pv-voltage"],
        ["charge-limit"],
      ],
    ],
  );
  assert.deepEqual(
    out.sources.map((s) => s.id).sort(),
    ["doc-epever-xtra", "doc-vedirect-whitepaper", "doc-victron-150-35"],
    "the sources cited and no other",
  );
  assert.deepEqual(out.properties, []);
  assert.deepEqual(out.gaps, [
    { model: "victron-energy-smartsolar-mppt-150-35", key: "pv.voc.max", reason: "no-registry" },
    { model: "epever-xtra4210n", key: "pv.voc.max", reason: "no-registry" },
  ]);
  assert.deepEqual(out.truncated, []);
  const lean = await bundle(db, RELEASE, {
    models: ["victron-energy-smartsolar-mppt-150-35"],
    claims: false,
    protocol: false,
  });
  assert.deepEqual([lean.claims, lean.protocol, lean.sources, lean.gaps], [[], [], [], []]);
  assert.deepEqual(properties(), []);
});

test("a list cut at its limit says so rather than looking complete", async () => {
  const many = Array.from({ length: LIMITS.bundleClaims + 1 }, (_, i) => ({
    id: `epever-xtra4210n--f${String(i).padStart(4, "0")}`,
    tier: "record",
    model_id: "epever-xtra4210n",
    name: `Figure ${i}`,
    value: String(i),
    source_id: `doc-${i}`,
    confidence: "vendor-doc",
  }));
  const { db } = await fixture({ specs: many });
  const out = await bundle(db, RELEASE, { models: ["epever-xtra4210n"], protocol: false });
  assert.equal(out.claims.length, LIMITS.bundleClaims);
  assert.deepEqual(out.truncated, ["claims", "sources"]);
  assert.equal(
    out.sources.length,
    0,
    "sources are those held, and none of the cited ids exist here",
  );
  assert.deepEqual(await sourcesById(db, RELEASE, ["doc-unrelated", "doc-nope"]), [
    { id: "doc-unrelated", url: "https://elsewhere.test/x.pdf" },
  ]);
});

test("a consumer gets the active release by default, a loaded one by id, and nothing else", async () => {
  const { db } = await fixture();
  assert.equal(await currentRelease(db), RELEASE);
  assert.equal(await loadedRelease(db, RELEASE), RELEASE);
  await assert.rejects(loadedRelease(db, OLDER), /is not loaded/);
  const info = await releaseInfo(db, RELEASE);
  assert.equal(info.contract, 1);
  assert.equal(info.publishedAt, "2026-09-11T10:00:00Z");
  assert.equal(info.counts.models, 7);
  // An older publication loaded later is retained and answers by id, while the active one stays.
  const older = await fixture({}, OLDER, "2026-09-10T10:00:00Z");
  await loadRelease(older.world.env.ARCHIVE, older.db, plain, OLDER);
  assert.equal(await currentRelease(older.db), OLDER, "in its own world it is the only release");
  const { world: w } = await fixture();
  const { store } = older.world;
  for (const [k, v] of store) w.store.set(k, v);
  await loadRelease(w.env.ARCHIVE, w.env.RELEASES, plain, OLDER);
  assert.equal(await currentRelease(w.env.RELEASES), RELEASE);
  assert.equal(await loadedRelease(w.env.RELEASES, OLDER), OLDER);
});

test("a lookup of many ids stays under D1's parameter ceiling, and a source list past the limit is refused (#83)", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `acme-m${String(i).padStart(3, "0")}`,
    tier: "record",
    manufacturer_id: "acme",
    manufacturer_name: "Acme",
    name: `M${String(i).padStart(3, "0")}`,
    kind: "inverter",
  }));
  const keys = many.map((m) => ({
    model_id: m.id,
    key: `acme${m.name.toLowerCase()}`,
    name_key: m.name.toLowerCase(),
    label: "Acme",
    via: "name",
  }));
  const sources = Array.from({ length: 150 }, (_, i) => ({
    id: `doc-${i}`,
    url: `https://x.test/${i}.pdf`,
  }));
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme" }],
    models: many,
    model_keys: keys,
    sources,
    specs: [],
    model_dialects: [],
    model_dialect_sources: [],
  });
  const page = await search(db, RELEASE, { brand: "Acme", limit: 100 });
  assert.equal(page.items.length, 100, "a full page of a hundred is read in chunks");
  assert.equal(page.truncated, true);
  const found = await sourcesById(
    db,
    RELEASE,
    sources.map((s) => s.id),
  );
  assert.equal(found.length, 150);
  await assert.rejects(
    sourcesById(
      db,
      RELEASE,
      Array.from({ length: LIMITS.sources + 1 }, (_, i) => `doc-${i}`),
    ),
    /at most 256 sources a call; 257 asked for/,
  );
});

test("a kind singles one model out of many sharing a key, and a prefix keeps its underscores (#83)", async () => {
  const twins = Array.from({ length: 15 }, (_, i) => ({
    id: `acme-twin-${i}`,
    tier: "record",
    manufacturer_id: "acme",
    manufacturer_name: "Acme",
    name: `Twin ${i}`,
    kind: i === 14 ? "inverter" : "battery",
  }));
  const keys = twins.map((m) => ({
    model_id: m.id,
    key: "acmetwin",
    name_key: "twin",
    label: "Acme",
    via: "name",
  }));
  const odd = {
    id: "acme-x_y",
    tier: "record",
    manufacturer_id: "acme",
    manufacturer_name: "Acme",
    name: "X_Y",
    kind: "meter",
  };
  const { db } = await fixture({
    models: [...twins, odd],
    model_keys: [
      ...keys,
      { model_id: odd.id, key: "acmex_y", name_key: "x_y", label: "Acme", via: "name" },
    ],
    specs: [],
    model_dialects: [],
    model_dialect_sources: [],
  });
  const one = await resolve(db, RELEASE, { brand: "Acme", model: "Twin", kind: "inverter" });
  assert.equal(one.outcome, "exact");
  if (one.outcome === "exact") assert.equal(one.model.id, "acme-twin-14");
  const all = await resolve(db, RELEASE, { brand: "Acme", model: "Twin" });
  assert.equal(all.outcome, "ambiguous");
  if (all.outcome === "ambiguous") {
    assert.equal(all.candidates.length, LIMITS.candidates);
    assert.equal(all.truncated, true);
  }
  const underscore = await search(db, RELEASE, { prefix: "x_", limit: 10 });
  assert.deepEqual(
    underscore.items.map((m) => m.id),
    ["acme-x_y"],
    "an underscore is a character, not a wildcard",
  );
  const percent = await search(db, RELEASE, { prefix: "%", limit: 10 });
  assert.deepEqual(percent.items, [], "a percent sign matches nothing rather than everything");
  assert.equal(
    SourcesQuery.safeParse(Array.from({ length: LIMITS.sources + 1 }, () => "s")).success,
    false,
  );
});

test("a cursor is bound to its search, and a forgotten release is refused before any table is read", async () => {
  const { db } = await fixture();
  const first = await search(db, RELEASE, { brand: "Victron", limit: 2 });
  assert.ok(first.cursor);
  await assert.rejects(
    search(db, RELEASE, { brand: "Victron", kind: "inverter", limit: 2, cursor: first.cursor }),
    /not a cursor this search gave out/,
    "a cursor from another filter is refused",
  );
  await assert.rejects(
    search(db, RELEASE, { brand: "Victron", limit: 2, cursor: JSON.stringify(["zzz", "zzz"]) }),
    /not a cursor/,
    "a made-up cursor is refused rather than skipping every row",
  );
  const [place, mark] = JSON.parse(first.cursor ?? "[]") as [number, string];
  await assert.rejects(
    search(db, RELEASE, { brand: "Victron", limit: 2, cursor: JSON.stringify([place + 1, mark]) }),
    /not a cursor/,
    "a cursor whose boundary was moved under a real digest is refused too",
  );
  await assert.rejects(
    search(db, RELEASE, { brand: "Victron", limit: 2, cursor: JSON.stringify([999_999, mark]) }),
    /not a cursor/,
    "a boundary the release does not hold is refused",
  );
  await assert.rejects(
    search(db, OLDER, { brand: "Victron", limit: 2, cursor: first.cursor }),
    /not a cursor/,
    "a cursor from another release is refused",
  );
  // Letting the release go removes its row first: a handle that checks its release each call
  // finds it gone at once, while its tables may still be emptying.
  const blocking: typeof db = {
    ...db,
    prepare: (sql: string) => {
      if (sql.startsWith("DELETE FROM models")) throw new Error("D1 is away mid-delete");
      return db.prepare(sql);
    },
  };
  await assert.rejects(forget(blocking, RELEASE), /mid-delete/);
  await assert.rejects(loadedRelease(db, RELEASE), /is not loaded/);
});

test("near neighbours count models, not the names that reach them, and a kind narrows them first", async () => {
  const twins = Array.from({ length: 15 }, (_, i) => ({
    id: `acme-near-${String(i).padStart(2, "0")}`,
    tier: "record",
    manufacturer_id: "acme",
    manufacturer_name: "Acme",
    name: `Near ${String(i).padStart(2, "0")}`,
    kind: i < 3 ? "inverter" : "battery",
  }));
  // Every model reaches under the maker's name and under a brand: two key rows a model.
  const keys = twins.flatMap((m) => [
    {
      model_id: m.id,
      key: `acme${m.name.toLowerCase().replace(" ", "")}`,
      name_key: m.name.toLowerCase().replace(" ", ""),
      label: "Acme",
      via: "name",
    },
    {
      model_id: m.id,
      key: `acmebrand${m.name.toLowerCase().replace(" ", "")}`,
      name_key: m.name.toLowerCase().replace(" ", ""),
      label: "Acme Brand",
      via: "name",
    },
  ]);
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme" }],
    models: twins,
    model_keys: keys,
    specs: [],
    model_dialects: [],
    model_dialect_sources: [],
  });
  const miss = await resolve(db, RELEASE, { brand: "Acme", model: "Near" });
  assert.equal(miss.outcome, "none");
  if (miss.outcome === "none") {
    assert.equal(
      new Set(miss.near.map((m) => m.id)).size,
      LIMITS.candidates,
      "twelve distinct models, not twelve rows",
    );
    assert.equal(miss.truncated, true);
  }
  const inverters = await resolve(db, RELEASE, {
    brand: "Acme",
    model: "Near",
    kind: "inverter",
  });
  if (inverters.outcome === "none") {
    assert.deepEqual(
      inverters.near.map((m) => m.id),
      ["acme-near-00", "acme-near-01", "acme-near-02"],
    );
    assert.equal(inverters.truncated, false);
  } else assert.fail(inverters.outcome);
});

test("a record model names its maker from the maker record, positions sort as numbers, and a kind narrows in SQL before any cap", async () => {
  const crowd = Array.from({ length: 201 }, (_, i) => ({
    id: `acme-crowd-${String(i).padStart(3, "0")}`,
    tier: "record",
    manufacturer_id: "acme",
    name: `Crowd ${String(i).padStart(3, "0")}`,
    kind: i === 200 ? "meter" : "battery",
  }));
  const keys = crowd.map((m) => ({
    model_id: m.id,
    key: "acmecrowd",
    name_key: "crowd",
    label: "Acme",
    via: "name",
  }));
  const gotchas = Array.from({ length: 11 }, (_, i) => ({
    dialect_id: "d",
    position: i,
    text: `g${i}`,
  }));
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme Power" }],
    models: [
      ...crowd,
      { id: "acme-linked", tier: "record", manufacturer_id: "acme", name: "Linked", kind: "meter" },
    ],
    model_keys: keys,
    dialects: [
      {
        id: "d",
        family: "modbus-rs485",
        manufacturer: "acme",
        confidence: "vendor-doc",
        refuter: "checked",
      },
    ],
    dialect_gotchas: gotchas,
    dialect_sources: [],
    dialect_kinds: [],
    model_dialects: [
      {
        model_id: "acme-linked",
        dialect_id: "d",
        evidence_kind: "catalogue-name",
        confidence: "vendor-doc",
      },
    ],
    model_dialect_sources: [],
    specs: [],
  });
  const meter = await resolve(db, RELEASE, { brand: "Acme", model: "Crowd", kind: "meter" });
  assert.equal(meter.outcome, "exact", "the one meter is found past two hundred batteries");
  if (meter.outcome === "exact") {
    assert.equal(meter.model.id, "acme-crowd-200");
    assert.deepEqual(
      meter.model.manufacturer,
      { id: "acme", name: "Acme Power" },
      "the maker's display name, not its id",
    );
  }
  const out = await bundle(db, RELEASE, { models: ["acme-linked"], claims: false });
  assert.deepEqual(
    out.protocol[0]?.dialect.gotchas,
    gotchas.map((g) => g.text),
    "eleven gotchas in their order",
  );
});

test("a label with another maker in front of a unique name is not that model, and a bare or abbreviated maker is", async () => {
  const { db } = await fixture();
  for (const label of [
    "Renogy SmartSolar MPPT 150/35",
    "SmartSolar MPPT 150/35 Renogy",
    "Energy SmartSolar MPPT 150/35",
  ]) {
    const found = await resolve(db, RELEASE, { label });
    assert.notEqual(found.outcome, "exact", `${label} is not the Victron model`);
  }
  for (const label of [
    "Victron SmartSolar MPPT 150/35",
    "Vic SmartSolar MPPT 150/35",
    "SmartSolar MPPT 150/35 Victron",
    "Victron Energy BlueSolar SmartSolar MPPT 150/35",
  ]) {
    const found = await resolve(db, RELEASE, { label });
    assert.equal(found.outcome, "exact", label);
  }
});

test("an exact match too wide to count is read no further than its bound, in SQL", async () => {
  const crowd = Array.from({ length: 230 }, (_, i) => ({
    id: `acme-same-${String(i).padStart(3, "0")}`,
    tier: "record",
    manufacturer_id: "acme",
    name: `Same ${String(i).padStart(3, "0")}`,
    kind: "inverter",
  }));
  const keys = crowd.map((m) => ({
    model_id: m.id,
    key: "acmesame",
    name_key: "same",
    label: "Acme",
    via: "alias",
  }));
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme" }],
    models: crowd,
    model_keys: keys,
    specs: [],
    model_dialects: [],
    model_dialect_sources: [],
  });
  const reads: string[] = [];
  const watched: typeof db = {
    ...db,
    prepare: (sql: string) => {
      if (sql.includes("FROM model_keys")) reads.push(sql);
      return db.prepare(sql);
    },
  };
  for (const q of [{ brand: "Acme", model: "Same" }, { model: "Same" }, { label: "Acme Same" }]) {
    const wide = await resolve(watched, RELEASE, q);
    assert.equal(wide.outcome, "ambiguous", JSON.stringify(q));
    if (wide.outcome === "ambiguous") {
      assert.equal(wide.candidates.length, LIMITS.candidates);
      assert.equal(wide.truncated, true);
    }
  }
  assert.equal(reads.length, 3);
  for (const sql of reads)
    assert.match(sql, /GROUP BY k\.model_id ORDER BY MIN\(k\.rowid\) LIMIT \?$/);
});

test("a kind narrows near neighbours in SQL, so the one of the right kind is found behind two hundred of another", async () => {
  const many = Array.from({ length: 205 }, (_, i) => ({
    id: `acme-zed-${String(i).padStart(3, "0")}`,
    tier: "record",
    manufacturer_id: "acme",
    name: `Zed ${String(i).padStart(3, "0")}`,
    kind: "inverter",
  }));
  const wanted = {
    id: "acme-zed-999",
    tier: "record",
    manufacturer_id: "acme",
    name: "Zed 999",
    kind: "charge-controller",
  };
  const models = [...many, wanted];
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme" }],
    models,
    model_keys: models.map((m) => ({
      model_id: m.id,
      key: `acme${m.name.toLowerCase().replace(" ", "")}`,
      name_key: m.name.toLowerCase().replace(" ", ""),
      label: "Acme",
      via: "name",
    })),
    specs: [],
    model_dialects: [],
    model_dialect_sources: [],
  });
  const miss = await resolve(db, RELEASE, {
    brand: "Acme",
    model: "Zed",
    kind: "charge-controller",
  });
  assert.equal(miss.outcome, "none");
  if (miss.outcome === "none") {
    assert.deepEqual(
      miss.near.map((m) => m.id),
      ["acme-zed-999"],
    );
    assert.equal(miss.truncated, false);
  }
});

test("a cursor stays short however long a name is, and a name with a separator in it pages straight", async () => {
  const longName = `Long ${"x".repeat(600)}`;
  const odd = [
    { id: "acme-long", tier: "record", manufacturer_id: "acme", name: longName, kind: "inverter" },
    { id: "acme-pipe", tier: "record", manufacturer_id: "acme", name: "Pipe|a", kind: "inverter" },
    {
      id: "acme-pipe-b",
      tier: "record",
      manufacturer_id: "acme",
      name: "Pipe|b",
      kind: "inverter",
    },
  ];
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme" }],
    models: odd,
    model_keys: [],
    specs: [],
    model_dialects: [],
    model_dialect_sources: [],
  });
  const first = await search(db, RELEASE, { brand: "Acme", limit: 1 });
  assert.deepEqual(
    first.items.map((m) => m.id),
    ["acme-long"],
  );
  assert.ok(first.cursor && first.cursor.length <= 60, "a fixed shape, not the name");
  const second = await search(db, RELEASE, { brand: "Acme", limit: 1, cursor: first.cursor });
  assert.deepEqual(
    second.items.map((m) => m.id),
    ["acme-pipe"],
  );
  const third = await search(db, RELEASE, { brand: "Acme", limit: 1, cursor: second.cursor });
  assert.deepEqual(
    third.items.map((m) => m.id),
    ["acme-pipe-b"],
  );
  assert.equal(third.truncated, false);
  assert.equal(third.cursor, undefined);
});

test("a brand more makers answer to than a page can bind is refused with the reason, and a prefix of nothing is refused", async () => {
  const twins = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `twin-${String(i).padStart(2, "0")}`,
      name: "Twin Maker",
    }));
  const { db } = await fixture({ manufacturers: twins(45) });
  assert.deepEqual(await search(db, RELEASE, { brand: "Twin Maker", limit: 5 }), {
    items: [],
    truncated: false,
  });
  const { db: crowded } = await fixture(
    { manufacturers: twins(46) },
    OLDER,
    "2026-09-10T10:00:00Z",
  );
  await assert.rejects(
    search(crowded, OLDER, { brand: "Twin Maker", limit: 5 }),
    /more than 45 makers answer to "Twin Maker"/,
  );
  await assert.rejects(
    search(db, RELEASE, { prefix: " - - ", limit: 5 }),
    /prefix has no letters or digits/,
    "not a page of everything",
  );
});

test("a link's citations come in their order past ten, and citations are read for the links kept, no more (#84)", async () => {
  const dialects = Array.from({ length: 65 }, (_, i) => ({
    id: `d${String(i).padStart(2, "0")}`,
    family: "modbus-rs485",
    manufacturer: "acme",
    confidence: "vendor-doc",
    refuter: "checked",
  }));
  const links = dialects.map((d) => ({
    model_id: "acme-many",
    dialect_id: d.id,
    evidence_kind: "vendor-doc",
    confidence: "vendor-doc",
  }));
  const citations = [
    ...Array.from({ length: 11 }, (_, i) => ({
      model_id: "acme-many",
      dialect_id: "d00",
      position: i,
      source_id: `c${i}`,
      citation: `c${i}`,
    })),
    {
      model_id: "acme-many",
      dialect_id: "d64",
      position: 0,
      source_id: "beyond",
      citation: "beyond the bound",
    },
  ];
  const { db } = await fixture({
    manufacturers: [{ id: "acme", name: "Acme" }],
    models: [
      { id: "acme-many", tier: "record", manufacturer_id: "acme", name: "Many", kind: "meter" },
    ],
    model_keys: [],
    dialects,
    dialect_gotchas: [],
    dialect_sources: [],
    dialect_kinds: [],
    model_dialects: links,
    model_dialect_sources: citations,
    specs: [],
    sources: [],
  });
  const out = await bundle(db, RELEASE, { models: ["acme-many"], claims: false });
  assert.equal(out.protocol.length, LIMITS.bundleProtocol);
  assert.deepEqual(out.truncated, ["protocol"]);
  assert.deepEqual(
    out.protocol[0]?.evidence?.sources.map((s) => s.source),
    Array.from({ length: 11 }, (_, i) => `c${i}`),
    "eleven citations in their order",
  );
  assert.ok(
    !out.protocol.some((p) => p.evidence?.sources.some((s) => s.source === "beyond")),
    "a dropped link's citations are not read",
  );
});

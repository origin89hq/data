import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { R2_AT_ONCE } from "../src/at-once.ts";
import {
  currentRuns,
  DATASET_PATH,
  datasetKey,
  datasetType,
  LOGO_PATH,
  newRun,
  pointerKey,
  readable,
  runDate,
  runPrefix,
} from "../src/runs.ts";
import { partKey } from "../src/work.ts";
import { watched, world } from "./world.ts";

const pointer = (entity: string) =>
  JSON.stringify({
    run: `2026-09-10-${entity}`,
    date: "2026-09-10",
    startedAt: "2026-09-10T00:00:00Z",
  });

/** An archive whose listings are counted: how many calls, and how many objects they returned. */
function counted(objects: Record<string, string>) {
  const { env } = world(objects);
  const list = env.ARCHIVE.list.bind(env.ARCHIVE);
  const listings: { prefix?: string; delimiter?: string; objects: number }[] = [];
  Object.assign(env.ARCHIVE, {
    list: async (options: {
      prefix?: string;
      delimiter?: string;
      cursor?: string;
      limit?: number;
    }) => {
      const page = await list(options);
      listings.push({
        prefix: options.prefix,
        delimiter: options.delimiter,
        objects: page.objects.length,
      });
      return page;
    },
  });
  return { env, listings };
}

test("the current runs are found from the entities, not from everything archived under them", async () => {
  const objects: Record<string, string> = {
    [pointerKey.documents("victron-energy")]: pointer("victron-energy"),
    [pointerKey.documents("epever")]: pointer("epever"),
    [pointerKey.sightings("solacity")]: pointer("solacity"),
    // A maker whose first run has not claimed itself yet: nothing current to report.
    "documents/renogy/runs/2026-09-10-renogy/plan.json": "{}",
  };
  // Two and a half thousand objects of one maker's history, which a listing of the root returned.
  for (let i = 0; i < 2500; i += 1)
    objects[
      `documents/victron-energy/runs/2026-08-01-old/converted/${String(i).padStart(64, "0")}.json`
    ] = "{}";
  const { env, listings } = counted(objects);

  const makers = await currentRuns(env.ARCHIVE, "documents");
  assert.deepEqual(
    makers.map((m) => [m.entity, m.pointer.run]),
    [
      ["epever", "2026-09-10-epever"],
      ["victron-energy", "2026-09-10-victron-energy"],
    ],
  );
  assert.deepEqual(
    listings,
    [{ prefix: "documents/", delimiter: "/", objects: 0 }],
    "one call, and no objects",
  );
  assert.deepEqual(
    (await currentRuns(env.ARCHIVE, "sightings")).map((s) => s.entity),
    ["solacity"],
  );
});

test("more entities than one page of a listing are all found", async () => {
  const objects: Record<string, string> = {};
  const makers = Array.from({ length: 1003 }, (_, i) => `maker-${String(i).padStart(4, "0")}`);
  for (const maker of makers) objects[pointerKey.documents(maker)] = pointer(maker);
  const { env, listings } = counted(objects);
  assert.deepEqual(
    (await currentRuns(env.ARCHIVE, "documents")).map((m) => m.entity),
    makers,
  );
  assert.equal(listings.length, 2, "a thousand to a page, and the three after");
});

test("pointers are read a few at a time, not one after another", async () => {
  const objects: Record<string, string> = {};
  const makers = Array.from({ length: 20 }, (_, i) => `maker-${String(i).padStart(2, "0")}`);
  for (const maker of makers) objects[pointerKey.documents(maker)] = pointer(maker);
  const { env } = world(objects);
  const { peak } = watched(env.ARCHIVE);
  assert.deepEqual(
    (await currentRuns(env.ARCHIVE, "documents")).map((m) => m.entity),
    makers,
  );
  assert.equal(
    peak((key) => (key.endsWith("/current.json") ? key : undefined)),
    R2_AT_ONCE,
  );
});

const crawls = ["seller-crawl", "page-crawl", "manufacturer-crawl"].map(
  (n) => [n, readFileSync(new URL(`../src/${n}.ts`, import.meta.url), "utf8")] as const,
);

test("two runs started in the same second are two runs", () => {
  const a = newRun();
  const b = newRun();
  assert.notEqual(
    a.id,
    b.id,
    "a day is not an identity; two crawls of one maker today are two runs",
  );
  assert.equal(a.date, b.date);
  assert.equal(runDate(a.id), a.date, "the day is still readable off the id");
});

test("a run writes only under itself, so nothing needs clearing and nothing is overwritten", () => {
  const one = runPrefix.documents("epever", "2026-09-09-aaaaaaaa");
  const two = runPrefix.documents("epever", "2026-09-09-bbbbbbbb");
  assert.notEqual(one, two);
  assert.ok(
    !one.startsWith(two) && !two.startsWith(one),
    "one run's prefix must not contain another's",
  );
  for (const [name, source] of crawls) {
    assert.doesNotMatch(
      source,
      /clearPrefix/,
      `${name} still deletes, which a run that owns its prefix never needs to`,
    );
  }
});

test("a run's own results are keyed by run, so two runs never share a directory", () => {
  const a = partKey.converted("epever", "2026-09-09-aaaaaaaa", "a".repeat(64));
  const b = partKey.converted("epever", "2026-09-09-bbbbbbbb", "a".repeat(64));
  assert.notEqual(a, b);
  assert.match(a, /documents\/epever\/runs\/2026-09-09-aaaaaaaa\//);
});

test("a reading is keyed by the document and the reader, because that is all it depends on", () => {
  const one = partKey.reading("a".repeat(64), "p2");
  assert.equal(one, `archive/${"a".repeat(64)}.p2.reading.json`);
  // Two prompts still keep their answers apart; two runs asking the same question do not pay twice.
  assert.notEqual(partKey.reading("a".repeat(64), "p1"), one);
});

test("a pointer is per entity, and says which run is current", () => {
  assert.equal(pointerKey.documents("epever"), "documents/epever/current.json");
  assert.equal(pointerKey.sightings("solacity"), "sightings/solacity/current.json");
  for (const [name, source] of crawls) {
    assert.match(
      source,
      /writePointer\(this\.env\.ARCHIVE/,
      `${name} never becomes the current run`,
    );
    assert.ok(
      source.indexOf("writePointer") < source.indexOf("ARCHIVE.put("),
      `${name} writes results before claiming the run`,
    );
  }
});

test("every key a writer produces sits under a prefix the read endpoint allows", () => {
  // The witness is the writers themselves. Content-addressing the readings moved them to
  // "archive/", the endpoint's list was not updated, and pull-specs got HTTP 400 for every one.
  const written = [
    runPrefix.documents("victron-energy", "2026-09-10-abcd1234"),
    runPrefix.sightings("the-cabin-depot", "2026-09-10-abcd1234"),
    runPrefix.guesses("the-cabin-depot", "2026-09-10-abcd1234", "ai:x"),
    pointerKey.documents("victron-energy"),
    pointerKey.sightings("the-cabin-depot"),
    partKey.reading("0".repeat(64), "ai_cf_meta_llama_p2"),
    partKey.markdown("0".repeat(64), "toMarkdown"),
    partKey.converted("victron-energy", "2026-09-10-abcd1234", "0".repeat(64)),
    partKey.classify("ai:x", "the-cabin-depot", "2026-09-10-abcd1234", 1),
    partKey.classified("ai:x", "0".repeat(64)),
  ];
  for (const key of written) assert.ok(readable(key), `${key} is written but cannot be read back`);
});

test("a prefix outside the archive, or one climbing out of it, is refused", () => {
  assert.equal(readable("secrets/"), false);
  assert.equal(readable(""), false);
  assert.equal(readable("documents/../secrets/"), false);
});

test("only a logo and a published table are readable without the control token", () => {
  // The archive holds every crawl, every document and every reading. Two shapes are public and the
  // patterns say so at both ends, which is what keeps "/v1/../documents/..." out.
  assert.equal(LOGO_PATH.test("/logos/victron-energy-128.png"), true);
  assert.equal(DATASET_PATH.test("/v1/specs.parquet"), true);
  assert.equal(DATASET_PATH.test("/v1/manufacturers.csv"), true);
  assert.equal(DATASET_PATH.test("/v1/manifest.json"), true);
  for (const closed of [
    "/v1/../documents/x.json",
    "/v1/specs.parquet/../../secret",
    "/documents/epever/current.json",
    "/archive/abc.reading.json",
    "/v2/specs.parquet",
    "/v1/specs.exe",
  ]) {
    assert.equal(DATASET_PATH.test(closed), false, `${closed} must not be public`);
    assert.equal(LOGO_PATH.test(closed), false, `${closed} must not be public`);
  }
});

test("a published file is named in the archive under its version, and served as what it is", () => {
  assert.equal(datasetKey("specs.parquet"), "dataset/v1/specs.parquet");
  assert.match(datasetType("specs.parquet"), /parquet/);
  assert.match(datasetType("specs.csv"), /text\/csv/);
  assert.match(datasetType("manifest.json"), /application\/json/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newRun, pointerKey, runDate, runPrefix } from "../src/runs.ts";
import { partKey } from "../src/work.ts";

const crawls = ["seller-crawl", "page-crawl", "manufacturer-crawl"].map((n) => [n, readFileSync(new URL(`../src/${n}.ts`, import.meta.url), "utf8")] as const);

test("two runs started in the same second are two runs", () => {
  const a = newRun();
  const b = newRun();
  assert.notEqual(a.id, b.id, "a day is not an identity; two crawls of one maker today are two runs");
  assert.equal(a.date, b.date);
  assert.equal(runDate(a.id), a.date, "the day is still readable off the id");
});

test("a run writes only under itself, so nothing needs clearing and nothing is overwritten", () => {
  const one = runPrefix.documents("epever", "2026-09-09-aaaaaaaa");
  const two = runPrefix.documents("epever", "2026-09-09-bbbbbbbb");
  assert.notEqual(one, two);
  assert.ok(!one.startsWith(two) && !two.startsWith(one), "one run's prefix must not contain another's");
  for (const [name, source] of crawls) {
    assert.doesNotMatch(source, /clearPrefix/, `${name} still deletes, which a run that owns its prefix never needs to`);
  }
});

test("results are keyed by run, which is what stopped two prompts' readings sharing a directory", () => {
  const p1 = partKey.reading("epever", "2026-09-09-aaaaaaaa", "a".repeat(64), "p1");
  const p2 = partKey.reading("epever", "2026-09-09-bbbbbbbb", "a".repeat(64), "p1");
  assert.notEqual(p1, p2);
  assert.match(p1, /documents\/epever\/runs\/2026-09-09-aaaaaaaa\//);
});

test("a pointer is per entity, and says which run is current", () => {
  assert.equal(pointerKey.documents("epever"), "documents/epever/current.json");
  assert.equal(pointerKey.sightings("solacity"), "sightings/solacity/current.json");
  for (const [name, source] of crawls) {
    assert.match(source, /writePointer\(this\.env\.ARCHIVE/, `${name} never becomes the current run`);
    assert.ok(source.indexOf("writePointer") < source.indexOf("ARCHIVE.put("), `${name} writes results before claiming the run`);
  }
});

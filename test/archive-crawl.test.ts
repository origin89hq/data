import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CLASSIFIER_ID, classifierKey } from "@origin89/equipment-schema/provenance";
import { readCrawl } from "../tools/gate/archive.ts";

const date = "2026-09-10";
const run = `${date}-test`;
const sightings = `sightings/shop/runs/${run}`;
const guesses = `guesses/shop/runs/${run}/${classifierKey()}`;
function fixture(): Record<string, string> {
  return {
    "sightings/shop/current.json": JSON.stringify({ run, date }),
    [`${sightings}/manifest.json`]: JSON.stringify({ pages: [{ page: 7 }] }),
    [`${sightings}/page-0007.jsonl`]: JSON.stringify({
      seller: "shop",
      productId: "1",
      handle: "battery",
      title: "100 Ah battery",
      brand: "Acme",
      url: "https://shop.test/battery",
      currency: "CAD",
      checkedAt: date,
      extractor: "shopify-feed",
    }),
    [`${guesses}/manifest.json`]: JSON.stringify({ parts: 1, pages: [{ page: 1 }] }),
    [`${guesses}/page-0001.jsonl`]: JSON.stringify({
      seller: "shop",
      productId: "1",
      kind: "battery",
      by: CLASSIFIER_ID,
    }),
  };
}
function archiveFetch(objects: Record<string, string>, requests: string[]) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const prefix = url.searchParams.get("prefix") ?? "";
    requests.push(prefix);
    const keys = Object.keys(objects)
      .filter((key) => key.startsWith(prefix))
      .sort();
    if (url.searchParams.has("list")) return Response.json({ keys });
    return keys.length
      ? new Response(keys.map((key) => objects[key]).join("\n"))
      : new Response(null, { status: 404 });
  };
}
function mockArchive(t: TestContext, objects = fixture()) {
  const before = process.env.OFFGRID_CONTROL_TOKEN;
  process.env.OFFGRID_CONTROL_TOKEN = "test-only";
  t.after(() => {
    if (before === undefined) delete process.env.OFFGRID_CONTROL_TOKEN;
    else process.env.OFFGRID_CONTROL_TOKEN = before;
  });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", archiveFetch(objects, requests));
  return requests;
}
test("a crawl uses its run and the classifier's independent part numbers", async (t) => {
  const requests = mockArchive(t);
  const result = await readCrawl("shop", date, false);
  assert.equal(result?.sightings.length, 1);
  assert.equal(result?.guesses.get("shop/1")?.kind, "battery");
  assert.deepEqual(result?.missingParts, []);
  assert.ok(requests.includes(`${guesses}/page-`));
  assert.ok(requests.every((key) => !key.includes(`shop/${date}/`)));
});
test("a different requested date refuses the current crawl before reading its records", async (t) => {
  const requests = mockArchive(t);
  await assert.rejects(
    readCrawl("shop", "2026-09-09", false),
    /current crawl is dated 2026-09-10, requested 2026-09-09/,
  );
  assert.deepEqual(requests, ["sightings/shop/current.json"]);
});
test("an absent current run returns no crawl", async (t) => {
  mockArchive(t, {});
  assert.equal(await readCrawl("shop", date, false), undefined);
});
test("an unfinished classification names its missing parts", async (t) => {
  const objects = fixture();
  objects[`${guesses}/manifest.json`] = JSON.stringify({ parts: 2 });
  mockArchive(t, objects);
  assert.deepEqual((await readCrawl("shop", date, false))?.missingParts, ["part 2"]);
});
test("one missing sightings page is visible even when another page exists", async (t) => {
  const objects = fixture();
  objects[`${sightings}/manifest.json`] = JSON.stringify({ pages: [{ page: 7 }, { page: 8 }] });
  mockArchive(t, objects);
  assert.deepEqual((await readCrawl("shop", date, false))?.missingParts, ["sightings page 8"]);
});
test("an unclassified crawl retains sightings without inventing guesses", async (t) => {
  const objects = fixture();
  delete objects[`${guesses}/manifest.json`];
  delete objects[`${guesses}/page-0001.jsonl`];
  mockArchive(t, objects);
  const result = await readCrawl("shop", date, false);
  assert.equal(result?.sightings.length, 1);
  assert.equal(result?.guesses.size, 0);
  assert.deepEqual(result?.missingParts, []);
});
function report(t: TestContext, objects: Record<string, string>, requestedDate = date) {
  const dir = mkdtempSync(join(tmpdir(), "gate-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "archive.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = (${archiveFetch.toString()})(${JSON.stringify(objects)}, []);`,
  );
  return spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      new URL("../apps/worker/scripts/gate-report.ts", import.meta.url).pathname,
      "shop",
      requestedDate,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, OFFGRID_CONTROL_TOKEN: "test-only" },
    },
  );
}
test("gate report reads the current run through the shared archive reader", (t) => {
  const result = report(t, fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 sightings, 1 brand strings, 1 classified/);
  assert.match(result.stdout, /Acme.*battery 1/);
});
test("gate report refuses a date mismatch", (t) => {
  const result = report(t, fixture(), "2026-09-09");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to read a different crawl/);
  assert.equal(result.stdout, "");
});
test("gate report refuses partial classifier evidence", (t) => {
  const objects = fixture();
  objects[`${guesses}/manifest.json`] = JSON.stringify({ parts: 2 });
  const result = report(t, objects);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete crawl: part 2/);
  assert.equal(result.stdout, "");
});

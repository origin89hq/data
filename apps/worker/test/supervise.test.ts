import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifierKey } from "../src/classify.ts";
import { type SupervisionReport, supervise, VISION_OFFERS_PER_PASS } from "../src/supervise.ts";
import { inputKey, type Work } from "../src/work.ts";
import { world } from "./world.ts";

const source = readFileSync(new URL("../src/supervise.ts", import.meta.url), "utf8");

const listing = (seller: string, title: string) => ({
  seller,
  productId: title,
  handle: title.toLowerCase().replaceAll(" ", "-"),
  url: `https://${seller}.test/products/${title.toLowerCase().replaceAll(" ", "-")}`,
  title,
  currency: "CAD",
  checkedAt: "2026-09-09",
  extractor: "shopify-feed",
});

const guessesManifest = (seller: string) =>
  `guesses/${seller}/runs/2026-09-09-${seller}/${classifierKey()}/manifest.json`;

/** A seller whose crawl finished and was never classified, with its listings on one page. */
function crawled(
  objects: Record<string, string>,
  seller: string,
  titles: string[],
  { pageMissing = false } = {},
) {
  const run = `2026-09-09-${seller}`;
  objects[`sightings/${seller}/current.json`] = JSON.stringify({
    run,
    date: "2026-09-09",
    startedAt: "2026-09-09T00:00:00Z",
  });
  objects[`sightings/${seller}/runs/${run}/manifest.json`] = JSON.stringify({
    sightings: titles.length,
    pages: [{ page: 1 }],
  });
  if (!pageMissing)
    objects[`sightings/${seller}/runs/${run}/page-0001.jsonl`] = titles
      .map((title) => JSON.stringify(listing(seller, title)))
      .join("\n");
}

/** A listing the current classifier has already answered. */
async function answered(objects: Record<string, string>, seller: string, title: string) {
  objects[`guesses/by-input/${classifierKey()}/${await inputKey(listing(seller, title))}.json`] =
    "{}";
}

/** A maker with one more converted document, which the page reader has not been offered. */
function converted(objects: Record<string, string>, maker: string, sha: string) {
  const base = `documents/${maker}/runs/2026-09-10-${maker}`;
  objects[`documents/${maker}/current.json`] = JSON.stringify({
    run: `2026-09-10-${maker}`,
    date: "2026-09-10",
    startedAt: "2026-09-10T00:00:00Z",
  });
  const index = objects[`${base}/converting.json`]
    ? JSON.parse(objects[`${base}/converting.json`])
    : { documents: [] };
  index.documents.push({ sha256: sha, url: `https://${maker}.test/${sha.slice(-2)}.pdf` });
  objects[`${base}/converting.json`] = JSON.stringify(index);
  objects[`${base}/converted/${sha}.json`] = "{}";
}

const started = (report: SupervisionReport, what: string) =>
  report.started.filter((s) => s.what === what).map((s) => [s.entity, s.detail]);
const classifiedTitles = (sent: Work[]) =>
  sent.flatMap((m) => (m.kind === "classify" ? m.sightings.map((s) => s.title) : [])).sort();

test("the supervisor never approves, because a gate something else can open is not a gate", () => {
  assert.doesNotMatch(
    source,
    /sendEvent/,
    "sending the approval event would make the download automatic",
  );
  assert.doesNotMatch(
    source,
    /crawl-approved|APPROVAL_EVENT/,
    "the supervisor must not know how to approve",
  );
  assert.match(source, /report\.blocked\.push/, "an unapproved maker is reported, not resolved");
});

test("it only fetches specification pages that were adopted into the feed list", () => {
  assert.match(source, /pages\.has\(maker\.maker\)/, "a page nobody adopted is not fetched");
});

test("a classification short of its own manifest is a concern, not something to retry forever", () => {
  assert.match(source, /report\.concerns\.push/);
  assert.match(source, /classified \$\{seller\.classified\.written\} of/);
});

test("a pass lists what the classifier has answered once, not once for each seller", async () => {
  // Listed per seller, the first pass after a new prompt spent nine seconds a seller relisting
  // the same eight thousand answers.
  const objects: Record<string, string> = {};
  crawled(objects, "shop-a", ["EPEver XTRA4210N", "Victron SmartSolar 100/50"]);
  crawled(objects, "shop-b", ["Renogy 100Ah LiFePO4"]);
  crawled(objects, "shop-c", ["Growatt SPF 3000"]);
  await answered(objects, "shop-a", "Victron SmartSolar 100/50");
  const { env, sent, listed } = world(objects);
  const answerListings = () => listed.filter((p) => p.startsWith("guesses/by-input/")).length;

  const report = await supervise(env, "2026-09-10");
  assert.equal(answerListings(), 1);
  assert.deepEqual(started(report, "classify"), [
    ["shop-a", "1 batches, 1 listings already answered"],
    ["shop-b", "1 batches, 0 listings already answered"],
    ["shop-c", "1 batches, 0 listings already answered"],
  ]);
  assert.deepEqual(
    classifiedTitles(sent),
    ["EPEver XTRA4210N", "Growatt SPF 3000", "Renogy 100Ah LiFePO4"],
    "the listing answered before the pass is not asked again",
  );

  await supervise(env, "2026-09-11");
  assert.equal(answerListings(), 1, "a pass with nobody left to classify lists nothing");
});

test("a seller that cannot be classified is a concern, and the pass goes on without it", async () => {
  const objects: Record<string, string> = {};
  crawled(objects, "shop-a", ["EPEver XTRA4210N"]);
  crawled(objects, "shop-b", ["Renogy 100Ah LiFePO4"], { pageMissing: true });
  crawled(objects, "shop-c", ["Growatt SPF 3000"]);
  converted(objects, "maker-01", "a".repeat(64));
  const { env, sent, read } = world(objects);

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(report.concerns, ["shop-b: classify failed: page 1 of shop-b is missing"]);
  assert.deepEqual(
    started(report, "classify").map(([seller]) => seller),
    ["shop-a", "shop-c"],
    "the sellers after it are still classified",
  );
  assert.deepEqual(
    started(report, "vision").map(([maker]) => maker),
    ["maker-01"],
    "and the makers too",
  );
  assert.deepEqual(read("supervision/latest.json"), report, "the report is still written");
  assert.equal(read(guessesManifest("shop-b")), undefined, "so the next pass tries it again");
  assert.deepEqual(classifiedTitles(sent), ["EPEver XTRA4210N", "Growatt SPF 3000"]);
});

test("a failed listing of the answers is listed again, never taken as nothing answered", async () => {
  // Taken as empty, it would send every listing the classifier had already answered back to it.
  const objects: Record<string, string> = {};
  crawled(objects, "shop-a", ["EPEver XTRA4210N"]);
  crawled(objects, "shop-b", ["Renogy 100Ah LiFePO4", "Growatt SPF 3000"]);
  await answered(objects, "shop-b", "Renogy 100Ah LiFePO4");
  const { env, sent } = world(objects);
  const list = env.ARCHIVE.list.bind(env.ARCHIVE);
  let attempts = 0;
  Object.assign(env.ARCHIVE, {
    list: async (options: { prefix?: string; cursor?: string; limit?: number }) => {
      if (options.prefix?.startsWith("guesses/by-input/") && ++attempts === 1)
        throw new Error("We encountered an internal error. Please try again.");
      return list(options);
    },
  });

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(report.concerns, [
    "shop-a: classify failed: We encountered an internal error. Please try again.",
  ]);
  assert.equal(attempts, 2);
  assert.deepEqual(started(report, "classify"), [
    ["shop-b", "1 batches, 1 listings already answered"],
  ]);
  assert.deepEqual(classifiedTitles(sent), ["Growatt SPF 3000"]);
});

test("an offer the queue refuses is a concern, and still counts toward the pass", async () => {
  const objects: Record<string, string> = {};
  const makers = Array.from(
    { length: VISION_OFFERS_PER_PASS + 1 },
    (_, i) => `maker-${String(i + 1).padStart(2, "0")}`,
  );
  for (const [i, maker] of makers.entries())
    converted(objects, maker, i.toString(16).padStart(64, "0"));
  const { env, sent, read } = world(objects);
  Object.assign(env.WORK, {
    sendBatch: async (batch: { body: Work }[]) => {
      if (batch.some((m) => m.body.kind === "vision" && m.body.manufacturer === "maker-01"))
        throw new Error("Queue sendBatch failed: internal error");
      sent.push(...batch.map((m) => m.body));
    },
  });

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(report.concerns, [
    "maker-01: vision failed: Queue sendBatch failed: internal error",
  ]);
  assert.deepEqual(
    started(report, "vision").map(([maker]) => maker),
    makers.slice(1, VISION_OFFERS_PER_PASS),
    "the makers after it are offered",
  );
  assert.deepEqual(
    report.blocked.map((b) => b.entity),
    makers.slice(VISION_OFFERS_PER_PASS),
    "the refused offer used its turn, so the last maker waits",
  );
  assert.equal(
    read("documents/maker-01/runs/2026-09-10-maker-01/seeing.json"),
    undefined,
    "the refused maker is offered again on the next pass",
  );
});

test("the page reader is offered whatever converted since it last looked, a pass's worth of makers at a time", async () => {
  const objects: Record<string, string> = {};
  const convert = (maker: string, sha: string) => converted(objects, maker, sha);
  const makers = Array.from(
    { length: VISION_OFFERS_PER_PASS + 5 },
    (_, i) => `maker-${String(i + 1).padStart(2, "0")}`,
  );
  for (const [i, maker] of makers.entries()) convert(maker, i.toString(16).padStart(64, "0"));
  const { env, sent, store } = world(objects);
  const offered = (report: SupervisionReport) =>
    report.started.filter((s) => s.what === "vision").map((s) => s.entity);

  const first = await supervise(env, "2026-09-10");
  assert.deepEqual(offered(first), makers.slice(0, VISION_OFFERS_PER_PASS));
  assert.deepEqual(
    first.blocked.map((b) => [b.entity, b.waitingOn]),
    makers.slice(VISION_OFFERS_PER_PASS).map((m) => [m, "its turn with the page reader"]),
    "the rest are reported as waiting, not forgotten",
  );
  assert.equal(sent.length, VISION_OFFERS_PER_PASS, "one converted document each");

  assert.deepEqual(
    offered(await supervise(env, "2026-09-11")),
    makers.slice(VISION_OFFERS_PER_PASS),
    "the pass after takes the rest",
  );
  assert.deepEqual(
    offered(await supervise(env, "2026-09-12")),
    [],
    "and once every run has been offered, nothing is offered again",
  );

  // A document that converts later reopens its maker, and only its maker.
  convert("maker-03", "f".repeat(64));
  for (const [key, value] of Object.entries(objects))
    store.set(key, new TextEncoder().encode(value));
  assert.deepEqual(offered(await supervise(env, "2026-09-13")), ["maker-03"]);
});

test("a maker offered only to an earlier page reader is offered to this one", async () => {
  // How the scans p1 kept as failed are read again: its offers do not count for p2 (#29).
  const objects: Record<string, string> = {};
  converted(objects, "maker-01", "a".repeat(64));
  converted(objects, "maker-02", "b".repeat(64));
  objects["documents/maker-01/runs/2026-09-10-maker-01/seeing.json"] = JSON.stringify({
    converted: 1,
    extractedBy: "ai:@cf/moonshotai/kimi-k2.7-code@vision-p1",
  });
  const { env, sent } = world(objects);
  const report = await supervise(env, "2026-09-11");
  assert.deepEqual(
    report.started.filter((s) => s.what === "vision").map((s) => s.entity),
    ["maker-01", "maker-02"],
  );
  assert.deepEqual(
    sent.map((m) => (m.kind === "vision" ? m.manufacturer : m.kind)),
    ["maker-01", "maker-02"],
  );
});

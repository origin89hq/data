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

/** A maker's current run with a plan offering `documents` documents, and optionally an earlier run. */
function discovered(
  objects: Record<string, string>,
  maker: string,
  documents: number,
  previous?: { run: string; documents: number },
) {
  const run = `2026-09-10-${maker}`;
  objects[`documents/${maker}/current.json`] = JSON.stringify({
    run,
    date: "2026-09-10",
    instance: `maker-${maker}-${run}`,
    startedAt: "2026-09-10T00:00:00Z",
  });
  const plan = (n: number) => ({
    documents: Array.from({ length: n }, (_, i) => ({
      url: `https://${maker}.test/${i}.pdf`,
      host: `${maker}.test`,
    })),
  });
  // The earlier run's plan is written first, since the archive orders runs by when they wrote.
  if (previous)
    objects[`documents/${maker}/runs/${previous.run}/plan.json`] = JSON.stringify(
      plan(previous.documents),
    );
  objects[`documents/${maker}/runs/${run}/plan.json`] = JSON.stringify(plan(documents));
}

test("an empty discovery that replaces a run with documents is a concern, and a first one is not", async () => {
  const objects: Record<string, string> = {};
  discovered(objects, "epever", 0, { run: "2026-09-09-0c71b6f7", documents: 4 });
  discovered(objects, "volthium", 0);
  discovered(objects, "victron", 0, { run: "2026-09-09-abcd", documents: 0 });
  discovered(objects, "renogy", 3, { run: "2026-09-09-efgh", documents: 40 });
  const { env } = world(objects);

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(report.concerns, [
    "epever: discovery found no documents; the previous run 2026-09-09-0c71b6f7 offered 4",
  ]);
  assert.deepEqual(
    report.blocked.map((b) => b.entity),
    ["renogy"],
    "a run that offers fewer documents than before still waits for approval, and is not a concern",
  );
});

test("a run that wrote no plan is asked how it is doing, and one that died is a concern", async () => {
  const objects: Record<string, string> = {};
  const pointer = (maker: string) =>
    JSON.stringify({
      run: `2026-09-10-${maker}`,
      date: "2026-09-10",
      instance: `maker-${maker}-2026-09-10-${maker}`,
      startedAt: "2026-09-10T00:00:00Z",
    });
  objects["documents/waaree/current.json"] = pointer("waaree");
  objects["documents/epever/current.json"] = pointer("epever");
  objects["documents/renogy/current.json"] = pointer("renogy");
  const { env, instances } = world(objects);
  instances.set("maker-waaree-2026-09-10-waaree", {
    status: "errored",
    error: { name: "Error", message: "discover pages: timed out" },
  });
  instances.set("maker-epever-2026-09-10-epever", { status: "running" });

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(report.concerns, [
    "renogy: discovery status failed: instance.not_found: maker-renogy-2026-09-10-renogy",
    "waaree: discovery run maker-waaree-2026-09-10-waaree errored before writing a plan: discover pages: timed out",
  ]);
});

test("a pass queues every listing of a crawl, answered before or not, and lists no answers", async () => {
  // The consumer reuses an answer it has, so the run still gets a guess for that listing (#16).
  // Skipped here, it had none, and the gate saw most of an unchanged shop as unclassified.
  const objects: Record<string, string> = {};
  crawled(objects, "shop-a", ["EPEver XTRA4210N", "Victron SmartSolar 100/50"]);
  crawled(objects, "shop-b", ["Renogy 100Ah LiFePO4"]);
  await answered(objects, "shop-a", "Victron SmartSolar 100/50");
  const { env, sent, listed } = world(objects);

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(started(report, "classify"), [
    ["shop-a", "1 batches of 2 listings"],
    ["shop-b", "1 batches of 1 listings"],
  ]);
  assert.deepEqual(classifiedTitles(sent), [
    "EPEver XTRA4210N",
    "Renogy 100Ah LiFePO4",
    "Victron SmartSolar 100/50",
  ]);
  assert.equal(listed.filter((p) => p.startsWith("guesses/by-input/")).length, 0);
});

test("a run classified before every listing was queued is classified again", async () => {
  // Its manifest left out the listings answered earlier, so its parts hold no guess for them (#16).
  const objects: Record<string, string> = {};
  crawled(objects, "shop-a", ["EPEver XTRA4210N", "Victron SmartSolar 100/50"]);
  crawled(objects, "shop-b", ["Renogy 100Ah LiFePO4"]);
  objects[guessesManifest("shop-a")] = JSON.stringify({
    parts: 1,
    sightings: 2,
    alreadyAnswered: 1,
  });
  objects[guessesManifest("shop-b")] = JSON.stringify({ parts: 1, sightings: 1 });
  objects[`guesses/shop-b/runs/2026-09-09-shop-b/${classifierKey()}/page-0001.jsonl`] = "{}\n";
  const { env, sent } = world(objects);

  const report = await supervise(env, "2026-09-10");
  assert.deepEqual(started(report, "classify"), [["shop-a", "1 batches of 2 listings"]]);
  assert.deepEqual(classifiedTitles(sent), ["EPEver XTRA4210N", "Victron SmartSolar 100/50"]);
  assert.deepEqual(report.concerns, [], "shop-b's manifest is whole, and its part is written");
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { PULL_PAGE_READER } from "@origin89/equipment-schema/provenance";
import type { DiscoverySeen, HostSeen } from "../src/discover.ts";
import { EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "../src/reading.ts";
import {
  emptyPlanReason,
  makerStates,
  PREVIOUS_RUNS_CONSIDERED,
  previousPlan,
  readyToPull,
} from "../src/state.ts";
import { partKey, readerKey } from "../src/work.ts";
import { world } from "./world.ts";

const RUN = "2026-09-10-abcd1234";
const BASE = `documents/maker/runs/${RUN}`;
const sha = (c: string) => c.repeat(64);
const doc = (c: string) => ({
  sha256: sha(c),
  url: `https://maker.test/${c}.pdf`,
  contentType: "application/pdf",
});

/** One maker's current run, written as far as `stages` says the pipeline got. */
function run(stages: {
  plan?: boolean;
  approved?: boolean;
  fetched?: number;
  sent?: string[];
  converted?: string[];
  text?: string[];
  pages?: string[];
}): Record<string, string> {
  const objects: Record<string, string> = {
    "documents/maker/current.json": JSON.stringify({
      run: RUN,
      date: "2026-09-10",
      startedAt: "2026-09-10T00:00:00Z",
    }),
  };
  if (stages.plan)
    objects[`${BASE}/plan.json`] = JSON.stringify({ documents: (stages.sent ?? ["b"]).map(doc) });
  if (stages.approved)
    objects[`${BASE}/manifest.json`] = JSON.stringify({
      approvedBy: "david",
      fetched: stages.fetched ?? (stages.sent ?? []).length,
    });
  if (stages.sent)
    objects[`${BASE}/converting.json`] = JSON.stringify({ documents: stages.sent.map(doc) });
  for (const c of stages.converted ?? []) objects[`${BASE}/converted/${sha(c)}.json`] = "{}";
  for (const c of stages.text ?? [])
    objects[partKey.reading(sha(c), readerKey(EXTRACTOR_ID))] = "{}";
  for (const c of stages.pages ?? [])
    objects[partKey.reading(sha(c), readerKey(VISION_EXTRACTOR_ID))] = "{}";
  return objects;
}

const state = async (objects: Record<string, string>) => {
  const [maker] = await makerStates(world(objects).env.ARCHIVE);
  assert.ok(maker, "one maker in the archive");
  return maker;
};

const host = (over: Partial<HostSeen> = {}): HostSeen => ({
  domain: "maker.test",
  host: "maker.test",
  status: 200,
  sitemap: "urlset",
  listed: 40,
  own: 40,
  requests: 1,
  refused: 0,
  silent: 0,
  childrenFailed: 0,
  childrenSkipped: 0,
  redirectedTo: [],
  ...over,
});

const seen = (over: Partial<DiscoverySeen> = {}): DiscoverySeen => ({
  hosts: [host()],
  pages: { read: 40, failed: {} },
  foreignDocumentHosts: {},
  redirectedTo: [],
  ...over,
});

test("an empty plan says why, in the order a person would fix things", () => {
  assert.equal(
    emptyPlanReason(undefined),
    "nothing to fetch; this maker publishes no documents we can reach",
    "a plan from before discovery wrote what it saw keeps the old sentence",
  );
  assert.equal(
    emptyPlanReason(seen({ redirectedTo: ["www.rehlko.com"] })),
    "nothing to fetch; the site redirects to www.rehlko.com, which the record does not claim",
  );
  // Two sitemap requests refused, then both home pages: four requests, every one a 403.
  const refusing = host({
    host: "www.maker.test",
    status: 403,
    sitemap: "none",
    listed: 0,
    own: 0,
    requests: 2,
    refused: 2,
  });
  assert.equal(
    emptyPlanReason(seen({ hosts: [refusing], pages: { read: 0, failed: { "403": 2 } } })),
    "nothing to fetch; the site refused the crawler (403 on 4 of 4 requests)",
  );
  const unanswering = host({
    host: "www.maker.test",
    status: 0,
    sitemap: "none",
    listed: 0,
    own: 0,
    requests: 2,
    silent: 2,
  });
  assert.equal(
    emptyPlanReason(seen({ hosts: [unanswering], pages: { read: 0, failed: { "0": 2 } } })),
    "nothing to fetch; the site did not answer",
  );
  assert.equal(
    emptyPlanReason(
      seen({
        hosts: [host({ sitemap: "index", requests: 4, childrenFailed: 3, listed: 1, own: 1 })],
        pages: { read: 1, failed: {} },
      }),
    ),
    "nothing to fetch; read 1 pages, none links a document, and 3 of its sitemaps could not be read",
  );
  assert.equal(
    emptyPlanReason(
      seen({
        hosts: [host({ sitemap: "index", requests: 21, childrenSkipped: 5, listed: 1, own: 1 })],
        pages: { read: 1, failed: {} },
      }),
    ),
    "nothing to fetch; read 1 pages, none links a document, and 5 of its sitemaps were left unopened",
  );
  assert.equal(
    emptyPlanReason(
      seen({ foreignDocumentHosts: { "cdn.shopify.com": 12, "x.cloudfront.net": 3 } }),
    ),
    "nothing to fetch; 15 documents are on cdn.shopify.com, x.cloudfront.net, which the record does not claim",
  );
  assert.equal(
    emptyPlanReason(seen({ pages: { read: 0, failed: { "404": 1, "500": 1 } } })),
    "nothing to fetch; no page could be read (1 answered 404, 1 answered 500)",
  );
  assert.equal(emptyPlanReason(seen()), "nothing to fetch; read 40 pages, none links a document");
});

test("a maker's state carries its run and instance, and an empty plan's reason", async () => {
  const objects = run({});
  objects["documents/maker/current.json"] = JSON.stringify({
    run: RUN,
    date: "2026-09-10",
    instance: `maker-maker-${RUN}`,
    startedAt: "2026-09-10T00:00:00Z",
  });
  objects[`${BASE}/plan.json`] = JSON.stringify({
    documents: [],
    discovery: seen({ redirectedTo: ["www.rehlko.com"] }),
  });
  const maker = await state(objects);
  assert.equal(maker.run, RUN);
  assert.equal(maker.instance, `maker-maker-${RUN}`);
  assert.equal(maker.offered, 0);
  assert.match(maker.waitingOn, /redirects to www\.rehlko\.com/);
});

test("the previous run is the last one that wrote a plan before this one, by the archive's clock", async () => {
  // Written in this order: an old run, a same-day run whose random suffix sorts after the
  // current one, a run that died before writing a plan, then the current run, then a later one.
  const objects: Record<string, string> = {
    "documents/maker/runs/2026-09-08-zzzz/plan.json": JSON.stringify({
      documents: [doc("a"), doc("b"), doc("c")],
    }),
    "documents/maker/runs/2026-09-10-zzzz/plan.json": JSON.stringify({
      documents: [doc("a"), doc("b")],
    }),
    "documents/maker/runs/2026-09-10-dead/manifest.json": "{}",
    ...run({ plan: true }),
    "documents/maker/runs/2026-09-11-newer/plan.json": JSON.stringify({ documents: [] }),
  };
  const bucket = world(objects).env.ARCHIVE;
  assert.deepEqual(
    await previousPlan(bucket, "maker", RUN),
    { run: "2026-09-10-zzzz", documents: 2 },
    "a name that sorts later is still the earlier run, and a run with no plan is passed over",
  );
  assert.deepEqual(await previousPlan(bucket, "maker", "2026-09-08-zzzz"), undefined);
  assert.deepEqual(
    await previousPlan(bucket, "maker", "2026-09-10-dead"),
    { run: "2026-09-11-newer", documents: 0 },
    "a current run with no plan yet is compared with the last plan there is",
  );
  assert.deepEqual(
    await previousPlan(bucket, "other", RUN),
    undefined,
    "a maker with no runs has no previous one",
  );
});

test("finding the previous plan asks about the newest runs only, one request each", async () => {
  const objects: Record<string, string> = {};
  for (let i = 1; i <= PREVIOUS_RUNS_CONSIDERED + 4; i += 1)
    objects[`documents/maker/runs/2026-08-${String(i).padStart(2, "0")}-old/plan.json`] =
      JSON.stringify({ documents: [doc("a")] });
  Object.assign(objects, run({ plan: true }));
  const { env, headed } = world(objects);
  assert.deepEqual(await previousPlan(env.ARCHIVE, "maker", RUN), {
    run: `2026-08-${PREVIOUS_RUNS_CONSIDERED + 4}-old`,
    documents: 1,
  });
  assert.equal(
    headed.filter((k) => k !== `${BASE}/plan.json`).length,
    PREVIOUS_RUNS_CONSIDERED,
    "the oldest runs are never asked about",
  );
});

test("a run that is converted and read is ready to pull", async () => {
  const maker = await state(
    run({ plan: true, approved: true, sent: ["b", "c"], converted: ["b", "c"], text: ["b", "c"] }),
  );
  assert.deepEqual([maker.sent, maker.converted, maker.read], [2, 2, 2]);
  assert.equal(readyToPull(maker), true);
});

test("a run discovery has just started is not, because pulling it would delete every figure", async () => {
  const maker = await state(run({ plan: true }));
  assert.equal(maker.waitingOn, "somebody to approve the download");
  assert.equal(readyToPull(maker), false);
  assert.equal(readyToPull(await state(run({}))), false, "nor one with no plan yet");
});

test("a run approved and still converting is not, nor one converted and read by nobody", async () => {
  const converting = await state(
    run({ plan: true, approved: true, sent: ["b", "c"], converted: ["b"], text: ["b"] }),
  );
  assert.deepEqual([converting.sent, converting.converted], [2, 1]);
  assert.equal(readyToPull(converting), false);
  const unread = await state(run({ plan: true, approved: true, sent: ["b"], converted: ["b"] }));
  assert.equal(readyToPull(unread), false);
});

test("conversion is finished at what was sent to it, which a dropped translation makes fewer than fetched", async () => {
  const maker = await state(
    run({
      plan: true,
      approved: true,
      fetched: 3,
      sent: ["b", "c"],
      converted: ["b", "c"],
      text: ["b"],
    }),
  );
  assert.deepEqual([maker.fetched, maker.sent, maker.converted], [3, 2, 2]);
  assert.equal(readyToPull(maker), true, "comparing converted with fetched would wait for ever");
});

test("a run with a reading that never landed is still pulled, as far as it was read", async () => {
  const maker = await state(
    run({ plan: true, approved: true, sent: ["b", "c"], converted: ["b", "c"], text: ["b"] }),
  );
  assert.match(maker.waitingOn, /^reading, 1 of 2 left/);
  assert.equal(readyToPull(maker), true, "a dead-lettered document should not hold the rest back");
});

test("a run only the page reader has read is not ready while the pull leaves that reader out", async () => {
  // The pull would take no readings for it, and then remove every unreviewed figure the maker has
  // as stale.
  const maker = await state(
    run({ plan: true, approved: true, sent: ["b"], converted: ["b"], pages: ["b"] }),
  );
  assert.deepEqual([maker.read, maker.seen], [undefined, 1]);
  assert.equal(PULL_PAGE_READER, false, "this is the pull without the page reader");
  assert.equal(readyToPull(maker), false);

  const alsoText = await state(
    run({
      plan: true,
      approved: true,
      sent: ["b", "c"],
      converted: ["b", "c"],
      text: ["c"],
      pages: ["b"],
    }),
  );
  assert.equal(readyToPull(alsoText), true, "a reading the pull takes makes the run ready");
});

test("an offer to an earlier page reader is not an offer to this one, so a new version offers every run again", async () => {
  const offered = (extractedBy?: string) => ({
    ...run({ plan: true, approved: true, sent: ["b"], converted: ["b"] }),
    [`${BASE}/seeing.json`]: JSON.stringify({
      converted: 1,
      ...(extractedBy === undefined ? {} : { extractedBy }),
    }),
  });
  assert.equal((await state(offered(VISION_EXTRACTOR_ID))).seeing, 1);
  assert.equal(
    (await state(offered("ai:@cf/moonshotai/kimi-k2.7-code@vision-p1"))).seeing,
    undefined,
    "offered to p1, whose readings kept rate-limited pages as read (#29)",
  );
  assert.equal((await state(offered())).seeing, undefined, "nor an offer that names no reader");
});

test("a state from a Worker that predates `sent` is never ready, whatever its words say", () => {
  const old = {
    maker: "m",
    date: "2026-09-10",
    converted: 2,
    read: 2,
    waitingOn: "its figures to be pulled into records",
  };
  assert.equal(readyToPull(old), false);
});

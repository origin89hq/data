import assert from "node:assert/strict";
import { test } from "node:test";
import type { DownloadDecision } from "@origin89/equipment-schema/documents";
import { PULL_PAGE_READER } from "@origin89/equipment-schema/provenance";
import { R2_AT_ONCE } from "../src/at-once.ts";
import { classifierKey } from "../src/classify.ts";
import type { DiscoverySeen, HostSeen } from "../src/discover.ts";
import { EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "../src/reading.ts";
import { pointerKey, runPrefix } from "../src/runs.ts";
import {
  awaitingApproval,
  emptyPlanReason,
  makerStates,
  PREVIOUS_RUNS_CONSIDERED,
  previousPlan,
  readyToPull,
  sellerStates,
} from "../src/state.ts";
import { partKey, readerKey } from "../src/work.ts";
import { watched, world } from "./world.ts";

const RUN = "2026-09-10-abcd1234";
const BASE = `documents/maker/runs/${RUN}`;
const sha = (c: string) => c.repeat(64);
const doc = (c: string) => ({
  sha256: sha(c),
  url: `https://maker.test/${c}.pdf`,
  contentType: "application/pdf",
});

/** One maker's current run, written as far as `stages` says the pipeline got. */
function run(
  stages: {
    plan?: boolean;
    /** What the plan offers, when that is not what was sent to conversion. */
    offered?: string[];
    decision?: DownloadDecision;
    approved?: boolean;
    fetched?: number;
    sent?: string[];
    converted?: string[];
    text?: string[];
    pages?: string[];
  },
  maker = "maker",
): Record<string, string> {
  const base = `documents/${maker}/runs/${RUN}`;
  const objects: Record<string, string> = {
    [`documents/${maker}/current.json`]: JSON.stringify({
      run: RUN,
      date: "2026-09-10",
      startedAt: "2026-09-10T00:00:00Z",
    }),
  };
  if (stages.plan)
    objects[`${base}/plan.json`] = JSON.stringify({
      documents: (stages.offered ?? stages.sent ?? ["b"]).map(doc),
    });
  if (stages.decision) objects[`${base}/decision.json`] = JSON.stringify(stages.decision);
  if (stages.approved)
    objects[`${base}/manifest.json`] = JSON.stringify({
      approvedBy: "david",
      fetched: stages.fetched ?? (stages.sent ?? []).length,
    });
  if (stages.sent)
    objects[`${base}/converting.json`] = JSON.stringify({ documents: stages.sent.map(doc) });
  for (const c of stages.converted ?? []) objects[`${base}/converted/${sha(c)}.json`] = "{}";
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
  rootRedirectedTo: [],
  listedElsewhere: [],
  listedElsewhereMore: 0,
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
    emptyPlanReason(
      seen({
        redirectedTo: ["www.rehlko.com"],
        hosts: [host({ redirectedTo: ["www.rehlko.com"], rootRedirectedTo: ["www.rehlko.com"] })],
      }),
    ),
    "nothing to fetch; the site redirects to www.rehlko.com, which the record does not claim",
  );
  assert.equal(
    emptyPlanReason(
      seen({ redirectedTo: ["cdn.x.test"], hosts: [host({ redirectedTo: ["cdn.x.test"] })] }),
    ),
    "nothing to fetch; read 40 pages, none links a document, and some requests landed on cdn.x.test",
    "a child sitemap that moved does not make the site one that moved",
  );
  assert.equal(
    emptyPlanReason(
      seen({
        hosts: [host({ listed: 120, own: 0, listedElsewhere: ["pulsetech.com"] })],
        pages: { read: 1, failed: {} },
      }),
    ),
    "nothing to fetch; the sitemap lists 120 pages on pulsetech.com, which the record does not claim",
  );
  assert.equal(
    emptyPlanReason(
      seen({
        hosts: [
          host({ listed: 9, own: 0, listedElsewhere: ["a", "b", "c"], listedElsewhereMore: 2 }),
        ],
        pages: { read: 1, failed: {} },
      }),
    ),
    "nothing to fetch; the sitemap lists 9 pages on a, b, c and 2 more hosts, which the record does not claim",
  );
  assert.equal(
    emptyPlanReason(seen({ redirectedTo: ["cdn.other.test"] })),
    "nothing to fetch; read 40 pages, none links a document, and some requests landed on cdn.other.test",
    "one page that went elsewhere is a footnote, not the reason",
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
    emptyPlanReason(seen({ foreignDocumentHosts: { a: 4, b: 3, c: 2, d: 1, e: 1 } })),
    "nothing to fetch; 11 documents are on a, b, c and 2 more hosts, which the record does not claim",
  );
  assert.equal(
    emptyPlanReason(seen({ pages: { listed: 3000, read: 150, failed: { "404": 2 } } })),
    "nothing to fetch; read 150 pages of 3000 the site lists, none links a document",
    "a sample says it was one",
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
    discovery: seen({
      redirectedTo: ["www.rehlko.com"],
      hosts: [host({ redirectedTo: ["www.rehlko.com"], rootRedirectedTo: ["www.rehlko.com"] })],
    }),
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
    run: `2026-08-${String(PREVIOUS_RUNS_CONSIDERED + 4).padStart(2, "0")}-old`,
    documents: 1,
  });
  // The window is counted in days and the current run's day is one of them.
  assert.equal(
    headed.filter((k) => k !== `${BASE}/plan.json`).length,
    PREVIOUS_RUNS_CONSIDERED - 1,
    "the oldest runs are never asked about",
  );
});

test("a day with many runs keeps them all in view, whatever their suffixes", async () => {
  // Thirteen runs today whose names all sort after the current one; the last written is the
  // previous run, and a bound by name would have dropped it.
  const objects: Record<string, string> = {};
  for (let i = 1; i <= PREVIOUS_RUNS_CONSIDERED + 1; i += 1)
    objects[`documents/maker/runs/2026-09-10-z${String(i).padStart(2, "0")}/plan.json`] =
      JSON.stringify({ documents: [doc("a"), doc("b")] });
  Object.assign(objects, run({ plan: true }));
  const { env } = world(objects);
  assert.deepEqual(await previousPlan(env.ARCHIVE, "maker", RUN), {
    run: `2026-09-10-z${String(PREVIOUS_RUNS_CONSIDERED + 1).padStart(2, "0")}`,
    documents: 2,
  });
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
  assert.equal(maker.decision, undefined);
  assert.equal(awaitingApproval(maker), true);
  assert.equal(readyToPull(maker), false);
  assert.equal(readyToPull(await state(run({}))), false, "nor one with no plan yet");
});

test("a refused download is decided, and says who refused it and why (#71)", async () => {
  const refused = await state(
    run({
      plan: true,
      offered: ["b", "c"],
      decision: { outcome: "refused", by: "ada", note: "trail cameras, not power equipment" },
    }),
  );
  assert.equal(refused.waitingOn, "download refused by ada: trail cameras, not power equipment");
  assert.equal(refused.decision, "refused");
  assert.equal(refused.approvedBy, undefined);
  assert.equal(awaitingApproval(refused), false, "nobody is needed for a run already refused");
  assert.equal(readyToPull(refused), false);
  const unexplained = await state(run({ plan: true, decision: { outcome: "refused", by: "ada" } }));
  assert.equal(unexplained.waitingOn, "download refused by ada");
});

test("an approval shows as soon as the run records it, before any document is in", async () => {
  const maker = await state(
    run({
      plan: true,
      offered: ["b", "c", "d"],
      decision: { outcome: "approved", by: "ada", permitted: 2 },
    }),
  );
  assert.equal(maker.waitingOn, "the download of 2 documents approved by ada");
  assert.equal(maker.approvedBy, "ada");
  assert.equal(maker.decision, "approved");
  assert.equal(awaitingApproval(maker), false);
  assert.equal(maker.fetched, undefined, "nothing counts as fetched until the manifest says so");
  assert.equal(readyToPull(maker), false);
  const one = await state(
    run({ plan: true, decision: { outcome: "approved", by: "ada", permitted: 1 } }),
  );
  assert.equal(one.waitingOn, "the download of 1 document approved by ada");
});

test("an approval that leaves nothing to fetch, and a plan nobody answered in time, are decided", async () => {
  const nothing = await state(
    run({ plan: true, decision: { outcome: "approved", by: "ada", permitted: 0 } }),
  );
  assert.equal(
    nothing.waitingOn,
    "nothing to fetch; the approval by ada names none of the hosts the documents are on",
  );
  assert.equal(awaitingApproval(nothing), false);
  const lapsed = await state(
    run({ plan: true, decision: { outcome: "lapsed", reason: "no answer within 3 days" } }),
  );
  assert.equal(lapsed.waitingOn, "download not approved: no answer within 3 days");
  assert.equal(lapsed.decision, "lapsed");
  assert.equal(lapsed.approvedBy, undefined);
  assert.equal(awaitingApproval(lapsed), false);
});

test("a decision record that does not parse leaves the run with a person, not decided", async () => {
  for (const unreadable of [
    '{"outcome":"maybe","by":"ada"}',
    '{"outcome":"refused"}',
    '{"outcome":"approved","by":"ada","permitted":-1}',
    JSON.stringify({ outcome: "refused", by: "ada", note: "n".repeat(1001) }),
  ]) {
    const objects = run({ plan: true });
    objects[`${BASE}/decision.json`] = unreadable;
    const maker = await state(objects);
    assert.equal(maker.waitingOn, "somebody to approve the download", unreadable);
    assert.equal(maker.decision, undefined, unreadable);
    assert.equal(awaitingApproval(maker), true, unreadable);
  }
});

test("a run approved before decisions were recorded counts as approved from its manifest", async () => {
  const maker = await state(run({ plan: true, approved: true, fetched: 1 }));
  assert.equal(maker.decision, "approved");
  assert.equal(maker.approvedBy, "david");
  assert.equal(awaitingApproval(maker), false);
  assert.equal(maker.waitingOn, "conversion to be started");
});

test("only a plan that offers documents can wait for approval", async () => {
  assert.equal(awaitingApproval(await state(run({}))), false, "no plan yet");
  const objects = run({});
  objects[`${BASE}/plan.json`] = JSON.stringify({ documents: [] });
  objects[`${BASE}/spec-pages.json`] = JSON.stringify({ candidates: 2 });
  const specOnly = await state(objects);
  assert.equal(specOnly.offered, 0);
  assert.equal(awaitingApproval(specOnly), false, "specification pages need nobody's approval");
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

/** The maker a run's key belongs to, for counting the makers being read at one moment. */
const makerOf = (key: string) => /^documents\/([^/]+)\/runs\//.exec(key)?.[1];

test("each maker's state is its own, in name order, with a few makers read at a time", async () => {
  // Eight makers at every stage, more than are read at once, none sharing a document.
  const objects: Record<string, string> = {
    ...run({ plan: true, approved: true, sent: ["8"], converted: [] }, "maker-h"),
    ...run({ plan: true }, "maker-a"),
    ...run({ plan: true, approved: true }, "maker-b"),
    ...run({ plan: true, approved: true, sent: ["1", "2"], converted: ["1"] }, "maker-c"),
    ...run(
      { plan: true, approved: true, sent: ["3", "4"], converted: ["3", "4"], text: ["3"] },
      "maker-d",
    ),
    ...run({ plan: true, approved: true, sent: ["5"], converted: ["5"], text: ["5"] }, "maker-e"),
    ...run({}, "maker-f"),
    ...run(
      { plan: true, approved: true, sent: ["6", "7"], converted: ["6", "7"], pages: ["6"] },
      "maker-g",
    ),
  };
  const { env } = world(objects);
  const { peak } = watched(env.ARCHIVE);
  const states = await makerStates(env.ARCHIVE);
  assert.deepEqual(
    states.map((m) => [m.maker, m.waitingOn, m.sent, m.converted, m.read, m.seen]),
    [
      ["maker-a", "somebody to approve the download", undefined, undefined, undefined, undefined],
      ["maker-b", "conversion to be started", undefined, undefined, undefined, undefined],
      ["maker-c", "conversion, 1 of 2 left", 2, 1, undefined, undefined],
      ["maker-d", "reading, 1 of 2 left", 2, 2, 1, undefined],
      ["maker-e", "its figures to be pulled into records", 1, 1, 1, undefined],
      ["maker-f", "discovery", undefined, undefined, undefined, undefined],
      ["maker-g", "reading, 2 of 2 left", 2, 2, undefined, 1],
      ["maker-h", "conversion, 1 of 1 left", 1, 0, undefined, undefined],
    ],
  );
  assert.equal(peak(makerOf), R2_AT_ONCE, "as many makers at once as there are connections");
});

test("a reading is found whichever digit its document starts with, the archive listed in parts at once", async () => {
  const docs = ["0", "7", "a", "f"];
  const objects = run({ plan: true, approved: true, sent: docs, converted: docs, text: docs });
  // A thousand pages of one scan, all in the part starting with "a": more than one page to list.
  for (let page = 1; page <= 1000; page += 1)
    objects[partKey.page(sha("a"), readerKey(VISION_EXTRACTOR_ID), page)] = "{}";
  const { env } = world(objects);
  const { asked, peak } = watched(env.ARCHIVE);
  const [maker] = await makerStates(env.ARCHIVE);
  assert.equal(maker?.read, 4);
  const listings = asked.filter((prefix) => prefix.startsWith("archive"));
  assert.deepEqual(
    [...new Set(listings)].sort(),
    [
      "archive/0",
      "archive/1",
      "archive/2",
      "archive/3",
      "archive/4",
      "archive/5",
      "archive/6",
      "archive/7",
      "archive/8",
      "archive/9",
      "archive/a",
      "archive/b",
      "archive/c",
      "archive/d",
      "archive/e",
      "archive/f",
    ],
    "sixteen parts, and never the whole archive in one listing",
  );
  assert.equal(
    listings.filter((p) => p === "archive/a").length,
    2,
    "a long part is listed to its end",
  );
  assert.equal(
    peak((key) => (key.startsWith("archive/") ? key : undefined)),
    R2_AT_ONCE,
  );
});

test("a run not sent to conversion is spared the reads that only follow it", async () => {
  const { env } = world(run({ plan: true, approved: true }));
  const { asked } = watched(env.ARCHIVE);
  const [maker] = await makerStates(env.ARCHIVE);
  assert.equal(maker?.waitingOn, "conversion to be started");
  assert.deepEqual(
    asked.filter((key) => key.startsWith(BASE)).sort(),
    [
      `${BASE}/converting.json`,
      `${BASE}/manifest.json`,
      `${BASE}/plan.json`,
      `${BASE}/spec-pages.json`,
    ],
    "no listing of its conversions and no offer to read",
  );
});

test("a plan with no manifest reads its decision and nothing that follows conversion (#71)", async () => {
  const { env } = world(run({ plan: true, decision: { outcome: "refused", by: "ada" } }));
  const { asked } = watched(env.ARCHIVE);
  const [maker] = await makerStates(env.ARCHIVE);
  assert.equal(maker?.waitingOn, "download refused by ada");
  assert.deepEqual(asked.filter((key) => key.startsWith(BASE)).sort(), [
    `${BASE}/converting.json`,
    `${BASE}/decision.json`,
    `${BASE}/manifest.json`,
    `${BASE}/plan.json`,
    `${BASE}/spec-pages.json`,
  ]);
});

test("a read that fails fails the whole state, rather than answering for the makers it reached", async () => {
  const objects: Record<string, string> = {};
  for (const maker of ["maker-a", "maker-b", "maker-c", "maker-d", "maker-e", "maker-f", "maker-g"])
    Object.assign(
      objects,
      run({ plan: true, approved: true, sent: ["b"], converted: ["b"] }, maker),
    );
  const manifest = world(objects).env.ARCHIVE;
  watched(manifest, (key) => key === `documents/maker-e/runs/${RUN}/manifest.json`);
  await assert.rejects(makerStates(manifest), /R2 refused documents\/maker-e\//);
  const listing = world(objects).env.ARCHIVE;
  watched(listing, (key) => key === "archive/b");
  await assert.rejects(makerStates(listing), /R2 refused archive\/b/);
});

test("each seller's state is its own, in name order, with a few sellers read at a time", async () => {
  const objects: Record<string, string> = {};
  const crawled = (
    seller: string,
    sightings?: number,
    guesses?: { parts: number; written: number; alreadyAnswered?: number },
  ) => {
    objects[pointerKey.sightings(seller)] = JSON.stringify({
      run: RUN,
      date: "2026-09-10",
      startedAt: "2026-09-10T00:00:00Z",
    });
    if (sightings !== undefined)
      objects[`${runPrefix.sightings(seller, RUN)}/manifest.json`] = JSON.stringify({ sightings });
    if (!guesses) return;
    const { written, ...manifest } = guesses;
    objects[`${runPrefix.guesses(seller, RUN, classifierKey())}/manifest.json`] =
      JSON.stringify(manifest);
    for (let part = 1; part <= written; part += 1)
      objects[partKey.classify(classifierKey(), seller, RUN, part)] = "";
  };
  crawled("shop-a", 25, { parts: 3, written: 2 });
  crawled("shop-b", 10);
  crawled("shop-c", 5, { parts: 1, written: 1, alreadyAnswered: 2 });
  crawled("shop-d");
  const whole = ["shop-e", "shop-f", "shop-g", "shop-h"];
  for (const shop of whole) crawled(shop, 1, { parts: 1, written: 1 });
  const { env } = world(objects);
  const { peak } = watched(env.ARCHIVE);
  assert.deepEqual(await sellerStates(env.ARCHIVE), [
    { seller: "shop-a", date: "2026-09-10", sightings: 25, classified: { parts: 3, written: 2 } },
    { seller: "shop-b", date: "2026-09-10", sightings: 10 },
    // Classified before every listing was queued, so classified again (#16).
    { seller: "shop-c", date: "2026-09-10", sightings: 5 },
    // A crawl that never finished.
    { seller: "shop-d", date: "2026-09-10" },
    ...whole.map((seller) => ({
      seller,
      date: "2026-09-10",
      sightings: 1,
      classified: { parts: 1, written: 1 },
    })),
  ]);
  assert.equal(
    peak((key) => /^(?:sightings|guesses)\/([^/]+)\/runs\//.exec(key)?.[1]),
    R2_AT_ONCE,
  );
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

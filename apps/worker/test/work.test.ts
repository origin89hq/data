import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { batches, LAST_ATTEMPT, partKey, SEND_BATCH, sendGroups, Work } from "../src/work.ts";

test("a page message names its page and the pages it belongs to, and cannot name a page past the last", () => {
  const page = {
    kind: "vision-page",
    run: "r",
    manufacturer: "m",
    date: "d",
    sha256: "a".repeat(64),
    url: "https://x.test/a.pdf",
    page: 2,
    pages: 3,
  };
  assert.equal(Work.safeParse(page).success, true);
  assert.equal(
    Work.safeParse({
      kind: "vision",
      run: "r",
      manufacturer: "m",
      date: "d",
      sha256: "a".repeat(64),
      url: "https://x.test/a.pdf",
    }).success,
    true,
  );
  assert.equal(
    Work.safeParse({ ...page, page: 4 }).success,
    false,
    "page four of three would leave the reading waiting for ever",
  );
  assert.equal(Work.safeParse({ ...page, page: 0 }).success, false, "pages are counted from one");
  assert.equal(Work.safeParse({ ...page, sha256: "../../etc/passwd" }).success, false);
  assert.equal(
    Work.safeParse({ ...page, pages: undefined }).success,
    false,
    "a page with no count cannot tell when the reading is whole",
  );
  assert.equal(Work.safeParse({ ...page, waits: 3 }).success, true, "a page that has waited");
  assert.equal(Work.safeParse({ ...page, waits: -1 }).success, false);
  assert.equal(Work.safeParse({ ...page, waits: 1.5 }).success, false);
});

test("the page reader's pace keeps a page's two calls under Kimi's twenty a minute", () => {
  // Cloudflare's published limit for @cf/moonshotai/kimi-k2.7-code on standard billing is twenty
  // requests a minute for the whole account. Over it, pages were refused faster than they could
  // wait, and 1,996 of 2,148 were kept as failed (#29).
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const pace =
    /"name":\s*"PAGE_READER_PACE"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(
      config,
    );
  assert.ok(pace, "the pace is configured");
  const [limit, period] = [Number(pace[1]), Number(pace[2])];
  assert.equal(period, 60, "counted by the minute, as the model's limit is");
  assert.ok(limit > 0 && limit * 2 <= 20, `${limit} pages a minute is ${limit * 2} calls`);
});

test("a page of a reading lives beside the document, and every page of it shares one prefix nothing else does", () => {
  const sha = "c".repeat(64);
  assert.equal(partKey.page(sha, "ex", 7), `archive/${sha}.ex.page-0007.json`);
  assert.ok(partKey.page(sha, "ex", 7).startsWith(partKey.pages(sha, "ex")));
  assert.ok(
    !partKey.reading(sha, "ex").startsWith(partKey.pages(sha, "ex")),
    "the reading itself is not one of its pages",
  );
  assert.ok(
    !partKey.page(sha, "other", 1).startsWith(partKey.pages(sha, "ex")),
    "nor is another reader's page",
  );
});

test("the last attempt the page reader counts on is the last one the queue makes", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const retries = Number(/"max_retries":\s*(\d+)/.exec(config)?.[1]);
  assert.equal(
    LAST_ATTEMPT,
    retries + 1,
    "a page that fails on its last delivery must be written down, or its reading never finishes",
  );
});

const sighting = {
  seller: "a",
  productId: "1",
  handle: "h",
  url: "https://a.test/p",
  title: "t",
  currency: "CAD",
  checkedAt: "2026-09-09",
  extractor: "shopify-feed",
};

test("a message is refused unless it is one of the kinds this consumer handles", () => {
  assert.equal(
    Work.safeParse({
      kind: "classify",
      seller: "a",
      date: "2026-09-09",
      run: "2026-09-09-abcd1234",
      part: 1,
      sightings: [sighting],
    }).success,
    true,
  );
  assert.equal(Work.safeParse({ kind: "sabotage", seller: "a" }).success, false);
  assert.equal(
    Work.safeParse({
      kind: "classify",
      seller: "a",
      date: "2026-09-09",
      run: "r",
      part: 0,
      sightings: [sighting],
    }).success,
    false,
    "parts are numbered from one",
  );
  assert.equal(
    Work.safeParse({
      kind: "classify",
      seller: "a",
      date: "2026-09-09",
      run: "r",
      part: 1,
      sightings: [],
    }).success,
    false,
    "an empty batch is a message that would spend a model call on nothing",
  );
});

test("a document message carries a real content hash, so a key cannot be forged from it", () => {
  const good = {
    kind: "convert",
    manufacturer: "m",
    date: "d",
    run: "r",
    sha256: "a".repeat(64),
    url: "https://x.test/a.pdf",
    contentType: "application/pdf",
  };
  assert.equal(Work.safeParse(good).success, true);
  assert.equal(Work.safeParse({ ...good, sha256: "../../etc/passwd" }).success, false);
  assert.equal(Work.safeParse({ ...good, sha256: "abc" }).success, false);
  assert.equal(Work.safeParse({ ...good, url: "not a url" }).success, false);
});

test("result keys are derived from the run, so a reader knows what to look for and two runs never mix", () => {
  assert.equal(
    partKey.classify("cls", "solacity", "2026-09-09-abcd1234", 7),
    "guesses/solacity/runs/2026-09-09-abcd1234/cls/page-0007.jsonl",
  );
  assert.equal(
    partKey.markdown("a".repeat(64), "conv"),
    `archive/${"a".repeat(64)}.conv.md`,
    "a document is keyed by its own bytes and belongs to no run",
  );
  assert.equal(
    partKey.converted("rolls", "r1", "b".repeat(64)),
    `documents/rolls/runs/r1/converted/${"b".repeat(64)}.json`,
  );
  assert.equal(
    partKey.reading("c".repeat(64), "ex"),
    `archive/${"c".repeat(64)}.ex.reading.json`,
    "a reading depends on the document and the reader, not on the run that asked",
  );
});

test("batching covers every item exactly once, whatever the remainder", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 10), []);
  assert.deepEqual(batches([1], 10), [[1]]);
  assert.equal(
    batches(
      Array.from({ length: 5600 }, (_, i) => i),
      10,
    ).flat().length,
    5600,
  );
});

test("a send is split by size as well as by count, because either limit alone lets through a batch the queue refuses", () => {
  const big = (part: number): Work => ({
    kind: "classify",
    seller: "a",
    date: "2026-09-09",
    run: "r",
    part,
    sightings: Array.from({ length: 10 }, () => ({ ...sighting, title: "x".repeat(300) })) as never,
  });
  const groups = sendGroups(Array.from({ length: 300 }, (_, i) => big(i + 1)));
  assert.ok(
    groups.length > 3,
    "counting messages alone would have sent three groups and been refused",
  );
  for (const g of groups) {
    assert.ok(g.length <= SEND_BATCH);
    assert.ok(JSON.stringify(g).length <= 260_000, "every group fits the queue's total size");
  }
  assert.equal(groups.flat().length, 300, "no message is dropped by the split");
});

test("a single message larger than the budget still goes, alone, rather than being silently dropped", () => {
  const huge: Work = {
    kind: "classify",
    seller: "a",
    date: "d",
    run: "r",
    part: 1,
    sightings: [{ ...sighting, title: "x".repeat(300_000) }] as never,
  };
  assert.deepEqual(sendGroups([huge]), [[huge]]);
});

test("a classification is keyed by what was classified, so the same listing at two shops is one question", async () => {
  const { inputKey } = await import("../src/work.ts");
  const a = { title: "EPEver XTRA4210N", brand: "EPEver", sku: "XTRA4210N" };
  assert.equal(await inputKey(a), await inputKey({ ...a }));
  assert.equal(await inputKey(a), await inputKey({ ...a, title: "EPEver XTRA4210N" }));
  assert.notEqual(await inputKey(a), await inputKey({ ...a, title: "EPEver XTRA3215N" }));
  assert.notEqual(await inputKey(a), await inputKey({ ...a, brand: "EP Solar" }));
});

test("a listing's rated figures are part of the question, and one without figures keeps its key", async () => {
  // The model is shown the figures, so a changed line is new evidence and must be asked again.
  const { inputKey } = await import("../src/work.ts");
  const a = { title: "EPEver XTRA4210N", brand: "EPEver", sku: "XTRA4210N" };
  assert.equal(
    await inputKey(a),
    "d91cafba73ccc94e168358b4ac025ce28335be7d",
    "the key a listing without figures had before figures were part of it",
  );
  const withFigures = await inputKey({ ...a, figures: "Rated charge current: 40 A" });
  assert.notEqual(withFigures, await inputKey(a));
  assert.notEqual(
    withFigures,
    await inputKey({ ...a, figures: "Rated charge current: 30 A" }),
    "and a changed line is a new question",
  );
});

test("a price or a crawl date does not change the question, so a re-crawl asks nothing new", async () => {
  const { inputKey } = await import("../src/work.ts");
  const base = { title: "Rolls S-550", brand: "Rolls", sku: "S-550" };
  const key = await inputKey(base);
  assert.equal(
    await inputKey({
      ...base,
      ...{ price: "999", checkedAt: "2027-01-01", seller: "elsewhere" },
    } as never),
    key,
  );
});

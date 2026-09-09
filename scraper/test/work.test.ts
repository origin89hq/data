import { test } from "node:test";
import assert from "node:assert/strict";
import { batches, partKey, sendGroups, SEND_BATCH, Work } from "../src/work.ts";

const sighting = { seller: "a", productId: "1", handle: "h", url: "https://a.test/p", title: "t", currency: "CAD", checkedAt: "2026-09-09", extractor: "shopify-feed" };

test("a message is refused unless it is one of the kinds this consumer handles", () => {
  assert.equal(Work.safeParse({ kind: "classify", seller: "a", date: "2026-09-09", part: 1, sightings: [sighting] }).success, true);
  assert.equal(Work.safeParse({ kind: "sabotage", seller: "a" }).success, false);
  assert.equal(Work.safeParse({ kind: "classify", seller: "a", date: "2026-09-09", part: 0, sightings: [sighting] }).success, false, "parts are numbered from one");
  assert.equal(Work.safeParse({ kind: "classify", seller: "a", date: "2026-09-09", part: 1, sightings: [] }).success, false, "an empty batch is a message that would spend a model call on nothing");
});

test("a document message carries a real content hash, so a key cannot be forged from it", () => {
  const good = { kind: "convert", manufacturer: "m", date: "d", sha256: "a".repeat(64), url: "https://x.test/a.pdf", contentType: "application/pdf" };
  assert.equal(Work.safeParse(good).success, true);
  assert.equal(Work.safeParse({ ...good, sha256: "../../etc/passwd" }).success, false);
  assert.equal(Work.safeParse({ ...good, sha256: "abc" }).success, false);
  assert.equal(Work.safeParse({ ...good, url: "not a url" }).success, false);
});

test("result keys are derived, so a reader knows what to look for and a gap stays visible", () => {
  assert.equal(partKey.classify("cls", "solacity", "2026-09-09", 7), "guesses/solacity/2026-09-09/cls/page-0007.jsonl");
  assert.equal(partKey.markdown("a".repeat(64), "conv"), `archive/${"a".repeat(64)}.conv.md`);
  assert.equal(partKey.converted("rolls", "d", "b".repeat(64)), `documents/rolls/d/converted/${"b".repeat(64)}.json`);
  assert.equal(partKey.reading("rolls", "d", "c".repeat(64), "ex"), `documents/rolls/d/readings/ex/${"c".repeat(64)}.json`);
});

test("batching covers every item exactly once, whatever the remainder", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 10), []);
  assert.deepEqual(batches([1], 10), [[1]]);
  assert.equal(batches(Array.from({ length: 5600 }, (_, i) => i), 10).flat().length, 5600);
});

test("a send is split by size as well as by count, because either limit alone lets through a batch the queue refuses", () => {
  const big = (part: number): Work => ({ kind: "classify", seller: "a", date: "2026-09-09", part, sightings: Array.from({ length: 10 }, () => ({ ...sighting, title: "x".repeat(300) })) as never });
  const groups = sendGroups(Array.from({ length: 300 }, (_, i) => big(i + 1)));
  assert.ok(groups.length > 3, "counting messages alone would have sent three groups and been refused");
  for (const g of groups) {
    assert.ok(g.length <= SEND_BATCH);
    assert.ok(JSON.stringify(g).length <= 260_000, "every group fits the queue's total size");
  }
  assert.equal(groups.flat().length, 300, "no message is dropped by the split");
});

test("a single message larger than the budget still goes, alone, rather than being silently dropped", () => {
  const huge: Work = { kind: "classify", seller: "a", date: "d", part: 1, sightings: [{ ...sighting, title: "x".repeat(300_000) }] as never };
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

test("a price or a crawl date does not change the question, so a re-crawl asks nothing new", async () => {
  const { inputKey } = await import("../src/work.ts");
  const base = { title: "Rolls S-550", brand: "Rolls", sku: "S-550" };
  const key = await inputKey(base);
  assert.equal(await inputKey({ ...base, ...{ price: "999", checkedAt: "2027-01-01", seller: "elsewhere" } } as never), key);
});

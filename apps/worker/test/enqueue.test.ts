import assert from "node:assert/strict";
import { test } from "node:test";
import { classifierKey } from "../src/classify.ts";
import { classifyRun, PAGES_AT_ONCE } from "../src/enqueue.ts";
import type { Work } from "../src/work.ts";
import { world } from "./world.ts";

const RUN = "2026-09-09-shop";
const pageKey = (page: number) =>
  `sightings/shop/runs/${RUN}/page-${String(page).padStart(4, "0")}.jsonl`;
const guessesManifest = `guesses/shop/runs/${RUN}/${classifierKey()}/manifest.json`;

const listing = (title: string) =>
  JSON.stringify({
    seller: "shop",
    productId: title,
    handle: title.replaceAll(" ", "-"),
    url: `https://shop.test/products/${title.replaceAll(" ", "-")}`,
    title,
    currency: "CAD",
    checkedAt: "2026-09-09",
    extractor: "shopify-feed",
  });

/** A finished crawl of `pages` pages with two listings each, titled by page and position. */
function crawl(pages: number) {
  const objects: Record<string, string> = {
    "sightings/shop/current.json": JSON.stringify({
      run: RUN,
      date: "2026-09-09",
      startedAt: "2026-09-09T00:00:00Z",
    }),
    [`sightings/shop/runs/${RUN}/manifest.json`]: JSON.stringify({
      sightings: pages * 2,
      pages: Array.from({ length: pages }, (_, i) => ({ page: i + 1 })),
    }),
  };
  for (let page = 1; page <= pages; page += 1)
    objects[pageKey(page)] = [listing(`page ${page} a`), listing(`page ${page} b`)].join("\n");
  return objects;
}

/** Page reads that take longer the earlier the page, counting how many are open at once. */
function slowPages(env: Env) {
  const get = env.ARCHIVE.get.bind(env.ARCHIVE);
  const reads = { open: 0, most: 0 };
  Object.assign(env.ARCHIVE, {
    get: async (key: string) => {
      const page = /page-(\d{4})\.jsonl$/.exec(key);
      if (!page) return get(key);
      reads.open += 1;
      reads.most = Math.max(reads.most, reads.open);
      await new Promise((resolve) => setTimeout(resolve, 20 - Number(page[1])));
      reads.open -= 1;
      return get(key);
    },
  });
  return reads;
}

const titles = (sent: Work[]) =>
  sent.flatMap((m) => (m.kind === "classify" ? m.sightings.map((s) => s.title) : []));

test("a crawl's listings are queued in page order, whichever page read finishes first", async () => {
  const { env, sent } = world(crawl(14));
  slowPages(env);

  const result = await classifyRun(env, "shop", "2026-09-09");
  assert.deepEqual(result, { parts: 3, sightings: 28 });
  assert.deepEqual(
    titles(sent),
    Array.from({ length: 14 }, (_, i) => [`page ${i + 1} a`, `page ${i + 1} b`]).flat(),
  );
});

test("a crawl's pages are read a few at a time, never all at once", async () => {
  const { env } = world(crawl(14));
  const reads = slowPages(env);

  await classifyRun(env, "shop", "2026-09-09");
  assert.equal(reads.most, PAGES_AT_ONCE);
});

test("a send that stops partway leaves no manifest, so the next pass classifies the run again", async () => {
  // 1,010 listings are 101 parts, two sends: a hundred, then one.
  const { env, sent, read } = world(crawl(505));
  const sendBatch = env.WORK.sendBatch.bind(env.WORK);
  let sends = 0;
  Object.assign(env.WORK, {
    sendBatch: async (batch: { body: Work }[]) => {
      if (++sends === 2) throw new Error("Queue sendBatch failed: internal error");
      return sendBatch(batch as never);
    },
  });
  await assert.rejects(classifyRun(env, "shop", "2026-09-09"), /internal error/);
  assert.equal(sent.length, 100, "the first send went");
  assert.equal(read(guessesManifest), undefined, "but no manifest promises the parts that did not");

  const result = await classifyRun(env, "shop", "2026-09-09");
  assert.deepEqual(result, { parts: 101, sightings: 1010 });
  assert.equal((read(guessesManifest) as { parts: number }).parts, 101);
});

test("a missing page fails the run before its manifest, and nothing is queued", async () => {
  const objects = crawl(8);
  delete objects[pageKey(7)];
  const { env, sent, read } = world(objects);

  await assert.rejects(classifyRun(env, "shop", "2026-09-09"), {
    message: "page 7 of shop is missing",
  });
  assert.equal(read(guessesManifest), undefined, "so the next pass tries the run again");
  assert.deepEqual(sent, []);
});

test("a line that is not a sighting fails the run before its manifest", async () => {
  const objects = crawl(3);
  objects[pageKey(2)] = `${listing("page 2 a")}\n{"title":"no seller, no url"}`;
  const { env, sent, read } = world(objects);

  await assert.rejects(classifyRun(env, "shop", "2026-09-09"), { name: "ZodError" });
  assert.equal(read(guessesManifest), undefined);
  assert.deepEqual(sent, []);
});

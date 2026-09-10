import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "../src/reading.ts";
import { makerStates, readyToPull } from "../src/state.ts";
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

test("a run only the page reader has read is ready, because its scans are what it read", async () => {
  const maker = await state(
    run({ plan: true, approved: true, sent: ["b"], converted: ["b"], pages: ["b"] }),
  );
  assert.deepEqual([maker.read, maker.seen], [undefined, 1]);
  assert.equal(readyToPull(maker), true);
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

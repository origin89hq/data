import assert from "node:assert/strict";
import { test } from "node:test";
import { settle } from "../src/settle.ts";
import type { Work } from "../src/work.ts";

const table = (url: string): Work => ({
  kind: "spec-table",
  run: "2026-09-10-aaaaaaaa",
  manufacturer: "maker",
  date: "2026-09-10",
  url,
});

/**
 * A batch as the queue hands it over, recording what was done with each message. Whatever a
 * handler that returns has neither acknowledged nor retried, the queue takes as done: "unsettled".
 */
function batch(bodies: unknown[]) {
  const outcome = bodies.map(() => "unsettled");
  const messages = bodies.map((body, i) => ({
    body,
    attempts: 1,
    ack: () => {
      outcome[i] = "ack";
    },
    retry: () => {
      outcome[i] = "retry";
    },
  }));
  return { batch: { messages } as unknown as MessageBatch<unknown>, outcome };
}

test("a message that does not parse is retried, so it can dead-letter, and the rest of its batch is still handled", async () => {
  const { batch: three, outcome } = batch([
    table("https://maker.test/a"),
    { kind: "vision-window", sha256: "not a message this version knows" },
    table("https://maker.test/c"),
  ]);
  const handled: string[] = [];
  await settle(three, async (work) => {
    if (work.kind === "spec-table") handled.push(work.url);
  });
  assert.deepEqual(handled, ["https://maker.test/a", "https://maker.test/c"]);
  assert.deepEqual(outcome, ["ack", "retry", "ack"]);
});

test("a message whose work fails is retried, and the next one is handled", async () => {
  const { batch: two, outcome } = batch([
    table("https://maker.test/a"),
    table("https://maker.test/b"),
  ]);
  await settle(two, async (work) => {
    if (work.kind === "spec-table" && work.url.endsWith("/a")) throw new Error("HTTP 503");
  });
  assert.deepEqual(outcome, ["retry", "ack"]);
});

test("a batch's messages are handled one at a time", async () => {
  const { batch: three } = batch([1, 2, 3].map((n) => table(`https://maker.test/${n}`)));
  let open = 0;
  let most = 0;
  await settle(three, async () => {
    open += 1;
    most = Math.max(most, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open -= 1;
  });
  assert.equal(most, 1);
});

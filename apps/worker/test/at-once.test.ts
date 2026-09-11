import assert from "node:assert/strict";
import { test } from "node:test";
import { atOnce } from "../src/at-once.ts";

/** Tasks that finish when a test says so, recording which have started. */
function held() {
  const started: number[] = [];
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const task = (item: number) =>
    new Promise<string>((resolve, reject) => {
      started.push(item);
      pending.set(item, { resolve, reject });
    });
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const finish = async (item: number) => {
    pending.get(item)?.resolve(`item ${item}`);
    await turn();
  };
  const fail = async (item: number, error: Error) => {
    pending.get(item)?.reject(error);
    await turn();
  };
  return { started, task, finish, fail, turn };
}

test("items finish in any order and are answered in theirs, never more than the limit at once", async () => {
  const { started, task, finish, turn } = held();
  const all = atOnce([0, 1, 2, 3, 4], 2, task);
  await turn();
  assert.deepEqual(started, [0, 1], "two at once, and only two");
  await finish(1);
  assert.deepEqual(started, [0, 1, 2], "the next starts when one finishes, whichever it was");
  await finish(2);
  await finish(3);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  await finish(4);
  await finish(0);
  assert.deepEqual(await all, ["item 0", "item 1", "item 2", "item 3", "item 4"]);
});

test("the first failure is the answer, and nothing starts after it", async () => {
  const { started, task, finish, fail, turn } = held();
  const all = atOnce([0, 1, 2, 3, 4, 5], 2, task);
  await turn();
  const refused = new Error("R2 answered 500");
  const rejected = assert.rejects(all, refused);
  await fail(1, refused);
  await rejected;
  await finish(0);
  assert.deepEqual(
    started,
    [0, 1],
    "a failed state must not go on reading the rest of the archive",
  );
});

test("a limit above the number of items runs them all at once", async () => {
  const { started, task, finish, turn } = held();
  const all = atOnce([0, 1, 2], 10, task);
  await turn();
  assert.deepEqual(started, [0, 1, 2]);
  for (const item of [2, 1, 0]) await finish(item);
  assert.deepEqual(await all, ["item 0", "item 1", "item 2"]);
});

test("nothing to do starts nothing, and a limit that would start nothing is refused", async () => {
  let calls = 0;
  const task = async (item: number) => {
    calls += 1;
    return item;
  };
  assert.deepEqual(await atOnce([], 6, task), []);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(atOnce([1, 2], limit, task), RangeError, `limit ${limit}`);
  assert.equal(calls, 0, "an empty answer for two items would read as nothing to do");
});

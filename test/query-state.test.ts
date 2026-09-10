import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { observeQueries, type QueryState } from "../apps/site/src/query-state.ts";
import type { Query } from "../apps/site/src/useDuckDb.ts";

const empty: Query = { columns: [], rows: [], ms: 0 };

test("a group stays loading until every query completes, preserving result order", async () => {
  const first = Promise.withResolvers<Query>();
  const second = Promise.withResolvers<Query>();
  const states: QueryState[] = [];
  const statements: string[] = [];
  observeQueries(
    (sql) => {
      statements.push(sql);
      return sql === "count" ? first.promise : second.promise;
    },
    ["count", "rows"],
    (state) => states.push(state),
  );
  assert.deepEqual(statements, ["count", "rows"]);
  assert.deepEqual(states, [{ status: "loading" }]);
  const record: Query = { columns: ["id"], rows: [{ id: "battery" }], ms: 4 };
  second.resolve(record);
  await setImmediate();
  assert.equal(states.length, 1);
  first.resolve({ columns: ["n"], rows: [{ n: 1 }], ms: 2 });
  await setImmediate();
  assert.deepEqual(states[1], {
    status: "ready",
    data: [{ columns: ["n"], rows: [{ n: 1 }], ms: 2 }, record],
  });
});

test("an empty result is ready, rather than loading or failed", async () => {
  const states: QueryState[] = [];
  observeQueries(
    async () => empty,
    ["no matches"],
    (state) => states.push(state),
  );
  await setImmediate();
  assert.deepEqual(states, [{ status: "loading" }, { status: "ready", data: [empty] }]);
});

test("a failed member never exposes partial rows, and a retry can recover", async () => {
  const states: QueryState[] = [];
  observeQueries(
    async (sql) => {
      if (sql === "count") throw new Error("Network unavailable");
      return empty;
    },
    ["count", "rows"],
    (state) => states.push(state),
  );
  await setImmediate();
  assert.deepEqual(states, [{ status: "loading" }, { status: "error" }]);
  observeQueries(
    async () => empty,
    ["count", "rows"],
    (state) => states.push(state),
  );
  await setImmediate();
  assert.deepEqual(states.slice(2), [
    { status: "loading" },
    { status: "ready", data: [empty, empty] },
  ]);
});

test("superseded and unmounted queries cannot publish late success or failure", async () => {
  for (const fail of [false, true]) {
    const deferred = Promise.withResolvers<Query>();
    const states: QueryState[] = [];
    const stop = observeQueries(
      () => deferred.promise,
      ["old search"],
      (state) => states.push(state),
    );
    stop();
    observeQueries(
      async () => empty,
      ["new search"],
      (state) => states.push(state),
    );
    await setImmediate();
    if (fail) deferred.reject(new Error("old failure"));
    else deferred.resolve({ columns: ["id"], rows: [{ id: "stale" }], ms: 1 });
    await setImmediate();
    assert.deepEqual(states, [
      { status: "loading" },
      { status: "loading" },
      { status: "ready", data: [empty] },
    ]);
  }
});

test("a synchronous query failure also leaves the loading state", async () => {
  const states: QueryState[] = [];
  observeQueries(
    () => {
      throw new Error("connection closed");
    },
    ["rows"],
    (state) => states.push(state),
  );
  await setImmediate();
  assert.deepEqual(states, [{ status: "loading" }, { status: "error" }]);
});

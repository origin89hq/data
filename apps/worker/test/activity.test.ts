import type { WorkflowStep } from "cloudflare:workers";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActivityEvent, ActivityQuery } from "@origin89/equipment-schema/activity";
import { activityPage, noteActivity, observeCollection, recordActivity } from "../src/activity.ts";
import { app } from "../src/routes.ts";
import { supervise } from "../src/supervise.ts";
import { world } from "./world.ts";

const event = (id: string, minute = 0): ActivityEvent => ({
  id,
  at: new Date(Date.UTC(2026, 8, 11, 8, minute)).toISOString(),
  kind: "collection_started",
  entity: "victron-energy",
  actor: "lemarier",
  summary: "Collection started",
  run: { kind: "maker", id: "2026-09-11-abcd", instance: "maker-victron-energy-2026-09-11-abcd" },
});
test("an event replay preserves its first timestamp and repairs an index write failure", async () => {
  const { env, store } = world();
  const put = env.ARCHIVE.put.bind(env.ARCHIVE);
  let fail = true;
  env.ARCHIVE.put = (async (key, ...args) => {
    if (key.startsWith("activity/feed/") && fail) {
      fail = false;
      throw Error("index offline");
    }
    return put(key, ...args);
  }) as typeof env.ARCHIVE.put;
  await assert.rejects(recordActivity(env.ARCHIVE, event("one")), /index offline/);
  await recordActivity(env.ARCHIVE, event("one", 10));
  await recordActivity(env.ARCHIVE, event("one", 20));
  assert.equal([...store.keys()].filter((key) => key.startsWith("activity/feed/")).length, 1);
  const page = await activityPage(env.ARCHIVE, ActivityQuery.parse({}));
  assert.deepEqual(page.events, [event("one")]);
});
test("newest-first pagination, filters, and time bounds do not skip matching events", async () => {
  const { env } = world();
  for (let i = 0; i < 12; i++)
    await recordActivity(env.ARCHIVE, {
      ...event(String(i), i),
      kind: i % 2 ? "approval_waiting" : "collection_started",
    });
  const first = await activityPage(
    env.ARCHIVE,
    ActivityQuery.parse({ kind: "approval_waiting", q: "LEMARIER", limit: 3 }),
  );
  assert.deepEqual(
    first.events.map((e) => e.id),
    ["11", "9", "7"],
  );
  const second = await activityPage(
    env.ARCHIVE,
    ActivityQuery.parse({ kind: "approval_waiting", limit: 3, cursor: first.cursor }),
  );
  assert.deepEqual(
    second.events.map((e) => e.id),
    ["5", "3", "1"],
  );
  const recent = await activityPage(
    env.ARCHIVE,
    ActivityQuery.parse({ since: event("cut", 10).at }),
  );
  assert.deepEqual(
    recent.events.map((e) => e.id),
    ["11", "10"],
  );
});
test("sparse filters are bounded and return a continuation even when the page is empty", async () => {
  const { env, listed } = world();
  for (let i = 0; i < 140; i++) await recordActivity(env.ARCHIVE, event(String(i), i));
  const result = await activityPage(env.ARCHIVE, ActivityQuery.parse({ q: "nobody" }));
  assert.equal(result.events.length, 0);
  assert.ok(result.cursor);
  assert.equal(listed.length, 5);
});
test("history routes require membership and reject invalid bounds before reading storage", async () => {
  const { env, listed } = world();
  Object.assign(env, { CONTROL_TOKEN: "test-token" });
  for (const path of ["/activity", "/releases", "/release-compare"]) {
    assert.equal((await app.request(`http://localhost:8790${path}`, {}, env)).status, 401);
  }
  for (const path of [
    "/activity?limit=0",
    "/activity?limit=51",
    "/activity?kind=made-up",
    "/activity?since=yesterday",
    "/release-compare?from=../private&to=nope",
  ]) {
    assert.equal(
      (
        await app.request(
          `http://localhost:8790${path}`,
          { headers: { authorization: "Bearer test-token" } },
          env,
        )
      ).status,
      400,
    );
  }
  assert.equal(listed.length, 0);
  const response = await app.request(
    "http://localhost:8790/activity",
    { headers: { authorization: "Bearer test-token" } },
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { events: unknown[] }).events, []);
});
const step = {
  do: async (_name: string, _options: unknown, work: () => Promise<unknown>) => work(),
} as unknown as WorkflowStep;
const collection = {
  entity: "acme",
  actor: "Scheduled collection",
  run: { kind: "seller" as const, id: "run-one", instance: "page-run-one" },
};
test("history failure cannot repeat or fail a successful collection; failed work preserves its error", async () => {
  const { env } = world();
  env.ARCHIVE.put = async () => {
    throw Error("storage offline");
  };
  let called = 0;
  assert.equal(
    await observeCollection(env.ARCHIVE, step, collection, async () => {
      called++;
      return "done";
    }),
    "done",
  );
  assert.equal(called, 1);
  const failure = Error("crawl failed");
  await assert.rejects(
    observeCollection(env.ARCHIVE, step, collection, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await noteActivity(env.ARCHIVE, event("nonfatal"));
});
test("collection outcomes and supervisor passes persist across subsequent reads", async () => {
  const { env } = world();
  await observeCollection(env.ARCHIVE, step, collection, async () => ({ sightings: 12 }));
  await supervise(env, "2026-09-11", "lemarier");
  const page = await activityPage(env.ARCHIVE, ActivityQuery.parse({}));
  assert.deepEqual(
    new Set(page.events.map((e) => e.kind)),
    new Set(["collection_started", "collection_completed", "supervision"]),
  );
  assert.equal(page.events.find((e) => e.kind === "supervision")?.actor, "lemarier");
  const { env: failed } = world();
  await assert.rejects(
    observeCollection(failed.ARCHIVE, step, collection, async () => {
      throw Error("network unavailable");
    }),
  );
  assert.ok(
    (await activityPage(failed.ARCHIVE, ActivityQuery.parse({}))).events.some(
      (e) => e.kind === "collection_failed",
    ),
  );
});

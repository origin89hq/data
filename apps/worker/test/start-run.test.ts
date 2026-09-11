import assert from "node:assert/strict";
import { test } from "node:test";
import { hasFeed } from "../src/feeds.ts";
import { manufacturers } from "../src/manufacturers.ts";
import { app } from "../src/routes.ts";
import { type Pointer, pointerKey, writePointer } from "../src/runs.ts";
import { sellers } from "../src/sellers.ts";
import { RunConflict, RunStartUncertain, startIfFree, startMaker } from "../src/start-run.ts";
import { world } from "./world.ts";

const KEY = pointerKey.documents("victron-energy");
const previous: Pointer = {
  run: "2026-09-10-old",
  date: "2026-09-10",
  instance: "maker-victron-energy-old",
  startedAt: "2026-09-10T00:00:00Z",
};
const makerPath = "/maker?id=victron-energy&domains=victronenergy.com&pages=20";
const request = (env: Env, path = makerPath) =>
  app.request(
    `http://localhost:8790${path}`,
    {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    },
    env,
  );

/** R2 uses the existing conditional-write fake; Workflows keeps each ID once, as createBatch does. */
function service(objects: Record<string, string> = {}) {
  const w = world(objects);
  const instances = new Map<string, string>();
  const calls: { id: string; params: unknown; tier: string }[] = [];
  const failures = { before: false, after: false, status: false };
  const hooks = { beforeCreate: async () => {}, beforeStatus: async () => {} };
  const binding = (tier: string) => ({
    createBatch: async (batch: { id: string; params: unknown }[]) => {
      const created = [];
      for (const options of batch) {
        calls.push({ ...options, tier });
        await hooks.beforeCreate();
        if (failures.before) throw Error("service unreachable");
        if (!instances.has(options.id)) {
          instances.set(options.id, "queued");
          created.push({ id: options.id });
        }
        if (failures.after) throw Error("response lost after commit");
      }
      return created;
    },
    get: async (id: string) => ({
      status: async () => {
        await hooks.beforeStatus();
        if (failures.status) throw Error("status unavailable");
        if (!instances.has(id)) throw Error("instance.not_found");
        return { status: instances.get(id) };
      },
    }),
  });
  Object.assign(w.env, {
    CONTROL_TOKEN: "test-token",
    MANUFACTURER_CRAWL: binding("maker"),
    SELLER_CRAWL: binding("feed"),
    PAGE_CRAWL: binding("page"),
  });
  return { ...w, instances, calls, failures, hooks };
}

test("each crawl tier reserves the visible run before the workflow starts", async () => {
  const feed = sellers.find(hasFeed);
  const page = sellers.find((s) => !hasFeed(s));
  assert.ok(feed && page);
  for (const [path, tier, key] of [
    [makerPath, "maker", KEY],
    [`/run?seller=${feed.id}&limit=1`, "feed", pointerKey.sightings(feed.id)],
    [`/run?seller=${page.id}&limit=500`, "page", pointerKey.sightings(page.id)],
  ] as const) {
    const w = service();
    w.hooks.beforeCreate = async () => {
      const reserved = w.readObject<Pointer>(key);
      assert.equal(reserved.instance, w.calls[0]?.id);
      const visible = await app.request(
        "http://localhost:8790/runs",
        {
          headers: { authorization: "Bearer test-token" },
        },
        w.env,
      );
      const body = (await visible.json()) as { runs: { instance: string }[] };
      assert.equal(body.runs[0]?.instance, reserved.instance);
      // A fast workflow's first step cannot erase a pending creation.
      await writePointer(w.env.ARCHIVE, key, reserved);
      assert.ok(w.readObject<{ creation?: unknown }>(key).creation);
    };
    const response = await request(w.env, path);
    assert.equal(response.status, 200);
    const { id } = (await response.json()) as { id: string };
    assert.equal(w.calls[0]?.tier, tier);
    assert.equal(w.instances.size, 1);
    const pointer = w.readObject<Pointer & { creation?: unknown }>(key);
    assert.equal(pointer.instance, id);
    assert.equal(pointer.creation, undefined);
    assert.ok(w.calls[0]);
    if (tier === "page") assert.equal((w.calls[0].params as { limit: number }).limit, 500);
    if (tier === "maker") assert.equal((w.calls[0].params as { pageLimit: number }).pageLimit, 20);
    if (tier === "feed") assert.equal((w.calls[0].params as { limit?: number }).limit, undefined);
  }
});

test("concurrent starts of the same terminal or absent run have exactly one winner", async () => {
  for (const exists of [false, true]) {
    const w = service(exists ? { [KEY]: JSON.stringify(previous) } : {});
    w.instances.set("maker-victron-energy-old", "complete");
    const [one, two] = await Promise.all([request(w.env), request(w.env)]);
    assert.deepEqual([one.status, two.status].sort(), [200, 409]);
    assert.equal(w.calls.length, 1);
    const accepted = one.status === 200 ? one : two;
    assert.equal(
      ((await accepted.json()) as { id: string }).id,
      w.readObject<Pointer>(KEY).instance,
    );
    // Workflow creation has not run its asynchronous pointer step, yet a new start is refused.
    assert.equal((await request(w.env)).status, 409);
    assert.equal(w.calls.length, 1);
  }
});

test("only terminal workflow states allow replacing a run; unknown status fails closed", async () => {
  for (const status of [
    "queued",
    "running",
    "waiting",
    "paused",
    "waitingForPause",
    "unknown",
    "complete",
    "errored",
    "terminated",
    "unavailable",
  ]) {
    const w = service({ [KEY]: JSON.stringify(previous) });
    w.instances.set("maker-victron-energy-old", status);
    w.failures.status = status === "unavailable";
    const response = await request(w.env);
    const terminal = ["complete", "errored", "terminated"].includes(status);
    assert.equal(response.status, terminal ? 200 : 409, status);
    assert.equal(w.calls.length, terminal ? 1 : 0, status);
    if (!terminal) assert.deepEqual(w.read(KEY), previous);
  }
  const w = service({ [KEY]: JSON.stringify({ ...previous, instance: undefined }) });
  assert.equal((await request(w.env)).status, 409);
  assert.equal(w.calls.length, 0);
});

test("recovery before or after a lost create response keeps the reserved ID and original bounds", async () => {
  for (const failure of ["before", "after"] as const) {
    const w = service();
    w.failures[failure] = true;
    assert.equal((await request(w.env)).status, 503);
    const reserved = w.readObject<Pointer & { creation?: unknown }>(KEY);
    assert.ok(reserved.creation);
    w.failures[failure] = false;
    const response = await request(
      w.env,
      "/maker?id=victron-energy&domains=victronenergy.com&pages=500",
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: string }).id, reserved.instance);
    assert.equal(w.instances.size, 1);
    assert.deepEqual(w.calls[1], w.calls[0]);
    assert.equal(w.readObject<{ creation?: unknown }>(KEY).creation, undefined);
    assert.equal((await request(w.env)).status, 409);
    assert.equal(w.calls.length, 2);
  }
});

test("a second request while creation is in flight can only reconcile that same instance", async () => {
  const w = service();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  w.hooks.beforeCreate = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = request(w.env);
  await entered.promise;
  w.hooks.beforeCreate = async () => {};
  const second = await request(w.env);
  assert.equal(second.status, 200);
  release.resolve();
  const one = await (await first).json();
  assert.deepEqual(one, await second.json());
  assert.equal(w.instances.size, 1);
  assert.equal(w.calls.length, 2);
  assert.deepEqual(w.calls[1], w.calls[0]);
});

test("an old or invalid unconfirmed reservation never expires into a new run", async (t) => {
  const realNow = Date.now;
  let clock: number | undefined;
  t.mock.method(Date, "now", () => clock ?? realNow());
  for (const age of [24 * 60 * 60 * 1000, Number.NaN, -1000]) {
    clock = undefined;
    const w = service();
    w.failures.before = true;
    await request(w.env);
    clock = realNow();
    const startedAt = Number.isNaN(age) ? "invalid" : new Date(clock - age).toISOString();
    const reserved = { ...w.readObject<Pointer>(KEY), startedAt };
    await w.env.ARCHIVE.put(KEY, JSON.stringify(reserved));
    w.failures.before = false;
    assert.equal((await request(w.env)).status, 409);
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.read(KEY), reserved);
  }
});

test("a failed reservation write creates no workflow, even if the write reached R2", async (t) => {
  const w = service();
  const put = w.env.ARCHIVE.put.bind(w.env.ARCHIVE);
  const failedPut = t.mock.method(
    w.env.ARCHIVE,
    "put",
    async (...args: Parameters<R2Bucket["put"]>) => {
      await put(...args);
      throw Error("R2 response lost");
    },
  );
  await assert.rejects(
    startMaker(w.env, "victron-energy", ["victronenergy.com"], 20),
    /R2 response lost/,
  );
  assert.equal(w.calls.length, 0);
  const reserved = w.readObject<Pointer>(KEY);
  failedPut.mock.restore();
  assert.equal(
    await startMaker(w.env, "victron-energy", ["victronenergy.com"], 20),
    reserved.instance,
  );
  assert.equal(w.instances.size, 1);
});

test("a delayed workflow cannot overwrite another run's reservation", async () => {
  const w = service();
  await writePointer(w.env.ARCHIVE, KEY, previous);
  w.instances.set("maker-victron-energy-old", "complete");
  await request(w.env);
  const current = w.read(KEY);
  await assert.rejects(writePointer(w.env.ARCHIVE, KEY, previous), /no longer owns/);
  assert.deepEqual(w.read(KEY), current);
});

test("invalid route inputs never reserve a run or invoke a workflow", async () => {
  const w = service();
  for (const path of [
    "/maker",
    "/maker?id=../victron-energy&domains=victronenergy.com",
    "/maker?id=victron-energy&domains=https://victronenergy.com",
    makerPath.replace("20", "0"),
    makerPath.replace("20", "1.5"),
    makerPath.replace("20", "501"),
    "/run?seller=missing",
    "/discover-all?pages=NaN",
  ]) {
    assert.equal((await request(w.env, path)).status, 400, path);
  }
  assert.equal(w.store.size, 0);
  assert.equal(w.calls.length, 0);
});

test("bulk discovery skips active makers while preserving the run creation guard", async (t) => {
  t.mock.method(console, "log", () => {});
  const maker = manufacturers[0];
  assert.ok(maker);
  const w = service({ [pointerKey.documents(maker.id)]: JSON.stringify(previous) });
  w.instances.set("maker-victron-energy-old", "waiting");
  const response = await request(w.env, "/discover-all?pages=1");
  const body = (await response.json()) as { started: number; skipped: string[] };
  assert.equal(response.status, 200);
  assert.equal(body.started, manufacturers.length - 1);
  assert.deepEqual(body.skipped, [maker.id]);
  assert.equal(w.calls.length, manufacturers.length - 1);
  assert.equal(
    await startIfFree(async () => {
      throw new RunConflict("active");
    }),
    undefined,
  );
  await assert.rejects(
    startIfFree(async () => {
      throw new RunStartUncertain("lost");
    }),
    RunStartUncertain,
  );
});

test("retained pointers can advance after the service explicitly reports an expired instance", async () => {
  for (const recent of [false, true]) {
    const pointer = {
      ...previous,
      startedAt: new Date(Date.now() - (recent ? 0 : 40 * 24 * 60 * 60 * 1000)).toISOString(),
    };
    const w = service({ [KEY]: JSON.stringify(pointer) });
    assert.equal((await request(w.env)).status, recent ? 409 : 200);
    assert.equal(w.calls.length, recent ? 0 : 1);
  }
  const w = service({ [KEY]: JSON.stringify({ ...previous, startedAt: "2020-01-01T00:00:00Z" }) });
  w.failures.status = true;
  assert.equal((await request(w.env)).status, 409, "old age does not excuse a service outage");
  assert.equal(w.calls.length, 0);
});

test("manufacturer discovery is restricted to that maker's configured domains", async () => {
  const w = service();
  for (const path of [
    "/maker?id=not-a-maker&domains=victronenergy.com",
    "/maker?id=victron-energy&domains=se.com",
    "/maker?id=victron-energy&domains=victronenergy.com,se.com",
    "/maker?id=victron-energy&domains=victronenergy.com.evil.test",
  ])
    assert.equal((await request(w.env, path)).status, 400, path);
  assert.equal(w.store.size, 0);
  assert.equal(w.calls.length, 0);
  assert.equal(
    (await request(w.env, "/maker?id=schneider-electric&domains=solar.se.com&pages=1")).status,
    200,
  );
  assert.ok(w.calls[0]);
  assert.deepEqual((w.calls[0].params as { domains: string[] }).domains, ["solar.se.com"]);
});

test("direct page-limit requests cannot bypass the bounded dashboard controls", async () => {
  const seller = sellers.find((item) => !hasFeed(item));
  assert.ok(seller);
  const w = service();
  for (const limit of ["-1", "0", "1.5", "501", "NaN", "Infinity", ""]) {
    for (const path of [
      `/maker?id=victron-energy&domains=victronenergy.com&pages=${limit}`,
      `/run?seller=${seller.id}&limit=${limit}`,
      `/discover-all?pages=${limit}`,
    ])
      assert.equal((await request(w.env, path)).status, 400, path);
  }
  assert.equal(w.store.size, 0);
  assert.equal(w.calls.length, 0);
  assert.equal((await request(w.env, `/run?seller=${seller.id}`)).status, 200);
  assert.ok(w.calls[0]);
  assert.equal((w.calls[0].params as { limit: number }).limit, 120);
});

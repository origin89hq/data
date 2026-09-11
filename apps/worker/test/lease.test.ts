import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEASE_KEY,
  LEASE_MS,
  LeaseHeld,
  OFFER_LEASE_MS,
  releaseLease,
  takeLease,
  underLease,
} from "../src/lease.ts";
import { app } from "../src/routes.ts";
import { OFFER_RETRY_MS, supervise, superviseIfFree } from "../src/supervise.ts";
import { world } from "./world.ts";

const T0 = Date.parse("2026-09-11T08:00:00Z");
const held = (until: number) => ({ [LEASE_KEY]: JSON.stringify({ holder: "someone", until }) });

const passHeld = new LeaseHeld(
  "a supervisor pass is running; its lease lasts until 2026-09-11T08:20:00.000Z",
  "pass",
  T0 + LEASE_MS,
);

test("the lease is taken when nobody holds it, and refused for as long as it lasts", async () => {
  const { env, read } = world();
  const taken = await takeLease(env.ARCHIVE, T0);
  assert.deepEqual(read(LEASE_KEY), { holder: taken.holder, until: T0 + LEASE_MS, what: "pass" });
  await assert.rejects(takeLease(env.ARCHIVE, T0 + LEASE_MS - 1), passHeld);
});

test("an offer holds the lease for a minute, and a caller refused is told it was an offer", async () => {
  const { env } = world();
  await takeLease(env.ARCHIVE, T0, { what: "offer", ms: OFFER_LEASE_MS });
  await assert.rejects(
    takeLease(env.ARCHIVE, T0 + 1),
    new LeaseHeld(
      "an offer to the page reader is running; its lease lasts until 2026-09-11T08:01:00.000Z",
      "offer",
      T0 + OFFER_LEASE_MS,
    ),
  );
  await takeLease(env.ARCHIVE, T0 + OFFER_LEASE_MS);
});

test("a lease that ran out is taken over, and one given back is free at once", async () => {
  const { env, read } = world(held(T0 - 1));
  const taken = await takeLease(env.ARCHIVE, T0);
  assert.equal((read(LEASE_KEY) as { holder: string }).holder, taken.holder, "the old one is gone");
  await releaseLease(env.ARCHIVE, taken);
  assert.deepEqual(read(LEASE_KEY), { holder: taken.holder, until: 0 });
  await takeLease(env.ARCHIVE, T0 + 1);
});

test("two passes asking at once: exactly one takes it", async () => {
  // Both read no lease before either writes one. The write is what decides, and only one lands.
  const { env } = world();
  const results = await Promise.allSettled([
    takeLease(env.ARCHIVE, T0),
    takeLease(env.ARCHIVE, T0),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.deepEqual(
    (results[1] as PromiseRejectedResult).reason,
    passHeld,
    "the one that lost is told until when, as for a lease found held",
  );

  // And the same race over a lease that ran out.
  const expired = world(held(T0 - 1));
  const over = await Promise.allSettled([
    takeLease(expired.env.ARCHIVE, T0),
    takeLease(expired.env.ARCHIVE, T0),
  ]);
  assert.deepEqual(
    over.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
});

test("giving a lease back never clears one the next pass took after it ran out", async () => {
  const { env, read } = world();
  const slow = await takeLease(env.ARCHIVE, T0);
  const next = await takeLease(env.ARCHIVE, T0 + LEASE_MS + 1);
  await releaseLease(env.ARCHIVE, slow);
  assert.deepEqual(read(LEASE_KEY), {
    holder: next.holder,
    until: T0 + 2 * LEASE_MS + 1,
    what: "pass",
  });
});

test("work under the lease gives it back however it ends", async () => {
  const { env, read } = world();
  await assert.rejects(
    underLease(env.ARCHIVE, async () => {
      throw new Error("R2 said no halfway through");
    }),
    /halfway through/,
  );
  assert.equal(
    (read(LEASE_KEY) as { until: number }).until,
    0,
    "given back, so the next pass runs",
  );
  assert.equal(await underLease(env.ARCHIVE, async () => "ran"), "ran");
});

test("a pass while another holds the lease queues nothing and writes no report", async () => {
  const { env, sent, read } = world({
    ...held(Date.now() + LEASE_MS),
    "documents/maker-01/current.json": JSON.stringify({
      run: "2026-09-10-maker-01",
      date: "2026-09-10",
      startedAt: "2026-09-10T00:00:00Z",
    }),
    "documents/maker-01/runs/2026-09-10-maker-01/converting.json": JSON.stringify({
      documents: [{ sha256: "a".repeat(64), url: "https://maker-01.test/a.pdf" }],
    }),
    [`documents/maker-01/runs/2026-09-10-maker-01/converted/${"a".repeat(64)}.json`]: "{}",
  });
  await assert.rejects(supervise(env, "2026-09-11"), LeaseHeld);
  assert.deepEqual(sent, [], "the maker is not offered to the page reader twice");
  assert.equal(read("supervision/latest.json"), undefined);

  // The scheduled pass steps aside at once for a pass, so the seller crawls after it still start.
  const naps: number[] = [];
  assert.equal(
    await superviseIfFree(env, "2026-09-11", async (ms) => void naps.push(ms)),
    undefined,
  );
  assert.deepEqual(naps, [], "a pass is not waited for: it is doing the same job");
  assert.deepEqual(sent, []);
});

test("the scheduled pass waits out an offer to the page reader, then runs", async () => {
  // An offer holds the lease for seconds and does none of a pass's work. Skipping the day's pass
  // for it would leave the classifications and conversions until tomorrow.
  const { env, store, read } = world({
    [LEASE_KEY]: JSON.stringify({ holder: "offer", until: Date.now() + 30_000, what: "offer" }),
  });
  const naps: number[] = [];
  const report = await superviseIfFree(env, "2026-09-11", async (ms) => {
    naps.push(ms);
    // The offer finishes and gives the lease back while the pass waits.
    store.set(LEASE_KEY, new TextEncoder().encode(JSON.stringify({ holder: "offer", until: 0 })));
  });
  assert.deepEqual(naps, [OFFER_RETRY_MS]);
  assert.ok(report, "the pass ran");
  assert.deepEqual(read("supervision/latest.json"), report);
});

test("the pass and an offer both answer 409 while a pass holds the lease", async () => {
  const env = { ...world(held(Date.now() + LEASE_MS)).env, CONTROL_TOKEN: "the-real-token" };
  const control = { method: "POST", headers: { authorization: "Bearer the-real-token" } };
  for (const path of ["/supervise", "/vision?id=maker-01&date=2026-09-10"]) {
    const res = await app.request(`http://localhost:8790${path}`, control, env as unknown as Env);
    assert.equal(res.status, 409, path);
    assert.match(((await res.json()) as { error: string }).error, /a supervisor pass is running/);
  }
});

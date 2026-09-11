import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadPartName } from "@origin89/equipment-schema/releases";
import { loadRelease, reloadPinned, type Steps } from "../src/release-load.ts";
import {
  activate,
  activeRelease,
  countRows,
  createSchema,
  forget,
  insertRows,
  LOADED_TABLES,
  releaseRow,
  retain,
  SCHEMA_VERSION,
} from "../src/release-store.ts";
import { loadKey, releaseKey } from "../src/releases.ts";
import { d1Double } from "./d1.ts";
import { world } from "./world.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plain: Steps = { do: (_name, fn) => fn() };

/** A release in the archive: its record, and each table's parts stored by hash. */
function published(
  objects: Record<string, string>,
  id: string,
  at: string,
  tables: Record<string, Record<string, unknown>[]>,
  options: { rowsPerPart?: number; dropPart?: string; lie?: string; omit?: string } = {},
): string {
  const files: Record<string, { rows: number; bytes: number; sha256: string }> = {};
  const load: {
    version: 1;
    tables: Record<string, { parts: string[]; rows: number; key?: string }>;
  } = {
    version: 1,
    tables: {},
  };
  for (const [table, rows] of Object.entries(tables)) {
    const parts: string[] = [];
    const per = options.rowsPerPart ?? 20_000;
    for (let at = 0; at < rows.length; at += per) {
      const name = loadPartName(table, parts.length + 1);
      const text = `${rows
        .slice(at, at + per)
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`;
      files[name] = {
        rows: Math.min(per, rows.length - at),
        bytes: text.length,
        sha256: sha256(text),
      };
      if (options.dropPart !== name) objects[loadKey(sha256(text))] = text;
      parts.push(name);
    }
    load.tables[table] = {
      parts,
      rows: options.lie === table ? rows.length + 1 : rows.length,
      key: "id",
    };
  }
  // Every table the store serves is in a plan, with nothing to load when it has no rows.
  for (const table of Object.keys(LOADED_TABLES))
    if (!(table in load.tables) && table !== options.omit)
      load.tables[table] = { parts: [], rows: 0 };
  objects[releaseKey(id)] = JSON.stringify({
    id,
    content: sha256(`content ${id}`),
    attempt: "1",
    at,
    sha: "a".repeat(40),
    job: "1",
    files,
    load,
  });
  return id;
}

const R1 = "1".repeat(64);
const R2 = "2".repeat(64);
const R3 = "3".repeat(64);
const models = (n: number, prefix = "m") =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    tier: "record",
    manufacturer_id: "acme",
    manufacturer_name: "Acme",
    name: `M-${i}`,
    kind: "inverter",
  }));

test("a release loads one part at a time, is counted against its plan, and becomes active", async () => {
  const objects: Record<string, string> = {};
  published(
    objects,
    R1,
    "2026-09-11T10:00:00Z",
    {
      models: models(7),
      model_keys: [{ model_id: "m0", key: "acmem0", name_key: "m0", label: "Acme", via: "name" }],
      specs: [{ id: "s0", model_id: "m0", name: "Power", value: "3000", unit: "W" }],
      feeds: [{ id: "sam-cec" }],
    },
    { rowsPerPart: 3 },
  );
  const { env } = world(objects);
  const steps: string[] = [];
  const step: Steps = {
    do: (name, fn) => {
      steps.push(name);
      return fn();
    },
  };
  const outcome = await loadRelease(env.ARCHIVE, env.RELEASES, step, R1);
  assert.deepEqual(outcome, { outcome: "loaded", active: true, retired: [] });
  assert.deepEqual(steps, [
    "read the release",
    "begin",
    "load models_0001.ndjson",
    "load models_0002.ndjson",
    "load models_0003.ndjson",
    "load model_keys_0001.ndjson",
    "load specs_0001.ndjson",
    "verify",
    "activate",
    "retain",
  ]);
  assert.equal(await countRows(env.RELEASES, "models", R1), 7);
  assert.equal((await activeRelease(env.RELEASES))?.id, R1);
  const row = await releaseRow(env.RELEASES, R1);
  const counted = Object.fromEntries(
    Object.entries(JSON.parse(row?.counts ?? "{}") as Record<string, number>).filter(
      ([, n]) => n > 0,
    ),
  );
  assert.deepEqual(counted, { models: 7, model_keys: 1, specs: 1 }, "and the rest counted at zero");
  const stored = await env.RELEASES.prepare(
    "SELECT name, kind, row FROM models WHERE release = ? AND id = 'm3'",
  )
    .bind(R1)
    .first<{ name: string; kind: string; row: string }>();
  assert.equal(stored?.name, "M-3");
  assert.equal(
    JSON.parse(stored?.row ?? "{}").manufacturer_name,
    "Acme",
    "the whole row rides along",
  );
  // A second load of the same release changes nothing.
  assert.deepEqual(await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1), {
    outcome: "already",
    state: "active",
  });
});

test("a load that cannot finish leaves the active release as it was, and says why", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(2) });
  published(
    objects,
    R2,
    "2026-09-11T11:00:00Z",
    { models: models(4) },
    { rowsPerPart: 2, dropPart: "models_0002.ndjson" },
  );
  const { env } = world(objects);
  await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1);
  const missing = await loadRelease(env.ARCHIVE, env.RELEASES, plain, R2);
  assert.equal(missing.outcome, "failed");
  assert.match(
    (missing as { reason: string }).reason,
    /models_0002\.ndjson .* is not in the archive/,
  );
  assert.equal((await activeRelease(env.RELEASES))?.id, R1);
  assert.equal((await releaseRow(env.RELEASES, R2))?.state, "failed");
  // A plan that promises more rows than the parts hold is a disagreement, not a shorter dataset.
  const objects2: Record<string, string> = {};
  published(objects2, R3, "2026-09-11T12:00:00Z", { models: models(2) }, { lie: "models" });
  const other = world(objects2);
  const lied = await loadRelease(other.env.ARCHIVE, other.env.RELEASES, plain, R3);
  assert.deepEqual(lied, { outcome: "failed", reason: "models: 2 rows loaded, the plan says 3" });
  // A release with no plan at all is not loadable.
  const bare: Record<string, string> = {};
  published(bare, R1, "2026-09-11T10:00:00Z", {});
  bare[releaseKey(R1)] = JSON.stringify({
    ...JSON.parse(bare[releaseKey(R1)] ?? "{}"),
    load: undefined,
  });
  const none = world(bare);
  assert.deepEqual(await loadRelease(none.env.ARCHIVE, none.env.RELEASES, plain, R1), {
    outcome: "failed",
    reason: "the release carries no load plan",
  });
});

test("a keyed table refuses a repeated id, so a release that repeats one does not load", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: [...models(2), ...models(1)] });
  const { env } = world(objects);
  const outcome = await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1);
  assert.equal(outcome.outcome, "failed");
  assert.match(
    (outcome as { reason: string }).reason,
    /UNIQUE constraint failed: models\.release, models\.id/,
  );
  assert.equal(await activeRelease(env.RELEASES), null);
});

test("the active pointer moves only to a newer publication, whatever order the loads finish in", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(1) });
  published(objects, R2, "2026-09-11T12:00:00Z", { models: models(2) });
  published(objects, R3, "2026-09-11T11:00:00Z", { models: models(3) });
  const { env } = world(objects);
  await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1);
  assert.equal((await activeRelease(env.RELEASES))?.id, R1);
  const newer = await loadRelease(env.ARCHIVE, env.RELEASES, plain, R2);
  assert.deepEqual(newer, { outcome: "loaded", active: true, retired: [] });
  const older = await loadRelease(env.ARCHIVE, env.RELEASES, plain, R3);
  assert.deepEqual(
    older,
    { outcome: "loaded", active: false, retired: [] },
    "an older publication loads but does not take over",
  );
  assert.equal((await activeRelease(env.RELEASES))?.id, R2);
  assert.equal((await releaseRow(env.RELEASES, R3))?.state, "retained");
  assert.equal(
    await countRows(env.RELEASES, "models", R3),
    3,
    "and stays loaded for a pinned lookup",
  );
});

test("retention keeps the pinned, the active and the recent, and lets the rest go in chunks", async () => {
  const objects: Record<string, string> = {};
  const ids = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(64));
  for (const [i, id] of ids.entries())
    published(objects, id, `2026-09-0${i + 1}T10:00:00Z`, { models: models(3, `r${i}`) });
  const { env } = world(objects);
  const keep = { recent: 2, pinned: [ids[0] ?? ""] };
  const outcomes = [];
  for (const id of ids)
    outcomes.push(await loadRelease(env.ARCHIVE, env.RELEASES, plain, id, keep));
  // Two recent kept beside the active one and the pinned first: the fifth load is the first to
  // let one go, the second.
  assert.deepEqual(
    outcomes.map((o) => (o.outcome === "loaded" ? o.retired : o.outcome)),
    [[], [], [], [], [ids[1]]],
  );
  const left = (
    await env.RELEASES.prepare("SELECT id, state FROM releases ORDER BY published_at").all<{
      id: string;
      state: string;
    }>()
  ).results;
  assert.deepEqual(
    left.map((r) => [r.id.slice(0, 1), r.state]),
    [
      ["1", "retained"],
      ["3", "retained"],
      ["4", "retained"],
      ["5", "active"],
    ],
  );
  assert.equal(
    await countRows(env.RELEASES, "models", ids[1] ?? ""),
    0,
    "a retired release's rows are gone",
  );
  assert.equal(await countRows(env.RELEASES, "models", ids[0] ?? ""), 3, "a pinned one's stay");
  // A deletion that stops part way leaves the release marked, off the loaded list, and on the
  // retention list: the next pass finishes it rather than leaving its rows behind unnamed.
  const third = ids[2] ?? "";
  let cut = false;
  const flaky: typeof env.RELEASES = {
    ...env.RELEASES,
    prepare: (sql: string) => {
      if (!cut && sql.startsWith("DELETE FROM specs")) {
        cut = true;
        throw new Error("D1 blinked");
      }
      return env.RELEASES.prepare(sql);
    },
  };
  await assert.rejects(forget(flaky, third), /D1 blinked/);
  assert.equal((await releaseRow(env.RELEASES, third))?.state, "deleting");
  assert.equal(await countRows(env.RELEASES, "models", third), 0, "its models went before the cut");
  assert.deepEqual(
    await retain(env.RELEASES, [third], 9),
    [third],
    "finished by the next pass, pinned or not",
  );
  assert.equal(await releaseRow(env.RELEASES, third), null);
});

test("a store double refuses what SQLite refuses, which is what the store relies on", async () => {
  const db = d1Double();
  await db.exec("CREATE TABLE t (release TEXT, id TEXT, PRIMARY KEY (release, id))");
  await db.batch([db.prepare("INSERT INTO t VALUES (?, ?)").bind("r", "a")]);
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO t VALUES (?, ?)").bind("r", "b"),
      db.prepare("INSERT INTO t VALUES (?, ?)").bind("r", "a"),
    ]),
    /UNIQUE constraint failed/,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM t").first<{ n: number }>())?.n,
    1,
    "a failed batch is rolled back whole",
  );
});

test("a part step run twice leaves one copy of its rows, so a retried step cannot double or trip on itself", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", {
    models: models(3),
    model_keys: [{ model_id: "m0", key: "k", name_key: "k", label: "L", via: "name" }],
  });
  const { env } = world(objects);
  await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1);
  const rows = [{ model_id: "m0", key: "k", name_key: "k", label: "L", via: "name" }];
  await insertRows(env.RELEASES, "model_keys", R1, "model_keys_0001.ndjson", rows);
  await insertRows(env.RELEASES, "model_keys", R1, "model_keys_0001.ndjson", rows);
  assert.equal(
    await countRows(env.RELEASES, "model_keys", R1),
    1,
    "an unkeyed table is not doubled",
  );
  await insertRows(env.RELEASES, "models", R1, "models_0001.ndjson", models(3));
  assert.equal(
    await countRows(env.RELEASES, "models", R1),
    3,
    "a keyed table does not trip on its own rows",
  );
});

test("a retention failure after activation is reported, and the release stays active", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(1) });
  const { env } = world(objects);
  const db = env.RELEASES;
  const failing: typeof db = {
    ...db,
    prepare: (sql: string) => {
      if (sql.startsWith("SELECT id, published_at, state FROM releases"))
        throw new Error("D1 is away");
      return db.prepare(sql);
    },
  };
  const outcome = await loadRelease(env.ARCHIVE, failing, plain, R1);
  assert.deepEqual(outcome, {
    outcome: "loaded",
    active: true,
    retired: [],
    retentionError: "D1 is away",
  });
  assert.equal((await activeRelease(db))?.id, R1);
});

test("taking the active place is one conditional switch, so an older load cannot overtake a newer one", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(1) });
  published(objects, R2, "2026-09-11T12:00:00Z", { models: models(1) });
  const { env } = world(objects);
  const db = env.RELEASES;
  await loadRelease(env.ARCHIVE, db, plain, R2);
  await db
    .prepare(
      "INSERT INTO releases (id, content, published_at, state, counts) VALUES (?, 'c', ?, 'loading', '{}')",
    )
    .bind(R1, "2026-09-11T10:00:00Z")
    .run();
  assert.equal(await activate(db, R1, "2026-09-11T10:00:00Z"), false, "the older one is retained");
  assert.equal((await activeRelease(db))?.id, R2);
  assert.equal((await releaseRow(db, R1))?.state, "retained");
  assert.equal(
    await activate(db, R2, "2026-09-11T12:00:00Z"),
    true,
    "activating the active one again is a no-op",
  );
});

test("a plan that leaves a store table out is refused, and a pinned release the store lacks is put back", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(1) }, { omit: "specs" });
  published(objects, R2, "2026-09-11T11:00:00Z", { models: models(1) });
  const { env, loads } = world(objects);
  const outcome = await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1);
  assert.deepEqual(outcome, { outcome: "failed", reason: "the load plan omits specs" });
  await loadRelease(env.ARCHIVE, env.RELEASES, plain, R2);
  // R2 is held, R1 failed, R3 is not in the archive at all: only R1 is put back.
  const started = await reloadPinned(env, env.RELEASES, [R2, R1, R3]);
  assert.deepEqual(started, [R1]);
  assert.deepEqual(
    loads.map((l) => l.params),
    [{ release: R1 }],
  );
  // A store with no tables at all, as a database just created has, is given them first.
  const fresh = d1Double();
  const w = world(objects);
  assert.deepEqual(await reloadPinned(w.env, fresh, [R2]), [R2]);
  assert.equal(await releaseRow(fresh, R2), null, "the load is started, not run here");
});

test("a keyed row without an id is refused, activation that stays away fails the load, and a partial retention says what went", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: [{ tier: "record", name: "no id" }] });
  const { env } = world(objects);
  const noId = await loadRelease(env.ARCHIVE, env.RELEASES, plain, R1);
  assert.equal(noId.outcome, "failed");
  assert.match((noId as { reason: string }).reason, /NOT NULL constraint failed: models\.id/);
  const objects2: Record<string, string> = {};
  published(objects2, R2, "2026-09-11T11:00:00Z", { models: models(1) });
  const w = world(objects2);
  const away: Steps = {
    do: (name, fn) =>
      name === "activate" ? Promise.reject(new Error("D1 is away for good")) : fn(),
  };
  const stuck = await loadRelease(w.env.ARCHIVE, w.env.RELEASES, away, R2);
  assert.deepEqual(stuck, { outcome: "failed", reason: "D1 is away for good" });
  assert.equal(
    (await releaseRow(w.env.RELEASES, R2))?.state,
    "failed",
    "not left loading for ever",
  );
  // Retention that fails on the second release to go still reports the first.
  const objects3: Record<string, string> = {};
  const ids = ["4".repeat(64), "5".repeat(64), "6".repeat(64), "7".repeat(64)];
  for (const [i, id] of ids.entries())
    published(objects3, id, `2026-09-0${i + 1}T10:00:00Z`, { models: models(1, `r${i}`) });
  const v = world(objects3);
  for (const id of ids.slice(0, 3))
    await loadRelease(v.env.ARCHIVE, v.env.RELEASES, plain, id, { recent: 9 });
  let deletes = 0;
  const flaky: typeof v.env.RELEASES = {
    ...v.env.RELEASES,
    prepare: (sql: string) => {
      if (sql.startsWith("DELETE FROM releases") && ++deletes === 2) throw new Error("D1 blinked");
      return v.env.RELEASES.prepare(sql);
    },
  };
  const partial = await loadRelease(v.env.ARCHIVE, flaky, plain, ids[3] ?? "", { recent: 0 });
  assert.equal(partial.outcome, "loaded");
  if (partial.outcome === "loaded") {
    assert.deepEqual(partial.retired, [ids[2]], "the one that went before the failure is named");
    assert.equal(partial.retentionError, "D1 blinked");
  }
});

test("a store stamped with another schema version is recreated whole; one at this version is left as it is", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(2) });
  const { env } = world(objects);
  const db = env.RELEASES;
  // A store from before a column existed: the table is there, narrower, under an older stamp.
  await db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await db.prepare("INSERT INTO meta VALUES ('schema_version', ?)").bind("0").run();
  await db.exec(
    "CREATE TABLE model_dialects (release TEXT NOT NULL, part TEXT NOT NULL, model_id TEXT, dialect_id TEXT, row TEXT NOT NULL)",
  );
  assert.equal(await createSchema(db), true, "an older stamp means a reset");
  const outcome = await loadRelease(env.ARCHIVE, db, plain, R1);
  assert.equal(outcome.outcome, "loaded", "and the wider table takes the load");
  assert.equal(await createSchema(db), false, "the same stamp changes nothing");
  assert.equal(await countRows(db, "models", R1), 2, "and the rows are still there");
  const stamp = await db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .first<{ value: string }>();
  assert.equal(stamp?.value, SCHEMA_VERSION);
});

test("a store with tables and no stamp is from before stamps, and is recreated", async () => {
  const objects: Record<string, string> = {};
  published(objects, R1, "2026-09-11T10:00:00Z", { models: models(1) });
  const { env } = world(objects);
  const db = env.RELEASES;
  await db.exec(
    "CREATE TABLE releases (id TEXT PRIMARY KEY, content TEXT NOT NULL, published_at TEXT NOT NULL, state TEXT NOT NULL, loaded_at TEXT, error TEXT, counts TEXT NOT NULL DEFAULT '{}')",
  );
  await db.exec(
    "CREATE TABLE model_dialects (release TEXT NOT NULL, part TEXT NOT NULL, model_id TEXT, dialect_id TEXT, row TEXT NOT NULL)",
  );
  assert.equal(await createSchema(db), true, "no stamp over existing tables is a reset");
  assert.equal((await loadRelease(env.ARCHIVE, db, plain, R1)).outcome, "loaded");
  const fresh = world(objects);
  assert.equal(
    await createSchema(fresh.env.RELEASES),
    false,
    "an empty store is created, not reset",
  );
});

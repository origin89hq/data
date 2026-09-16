import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityQuery } from "@origin89/equipment-schema/activity";
import {
  CompareQuery,
  type Release,
  SNAPSHOT_PART_MAX,
  SNAPSHOT_PART_ROWS,
  snapshotPartName,
} from "@origin89/equipment-schema/releases";
import { activityPage, digest } from "../src/activity.ts";
import {
  compareReleases,
  getRelease,
  indexRelease,
  releasePage,
  saveRelease,
  snapshotKey,
} from "../src/releases.ts";
import { world } from "./world.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;
async function stored(bucket: R2Bucket, text: string) {
  const hash = await digest(text);
  await bucket.put(snapshotKey(hash), text, { sha256: hash });
  return { bytes: bytes(text), sha256: hash };
}
/** A release as the build publishes one: the models given, each inner list a snapshot part, in the order given. */
async function version(
  bucket: R2Bucket,
  parts: { id: string; [field: string]: unknown }[][],
  sha = "a".repeat(40),
) {
  const files: Release["files"] = {};
  for (const [at, part] of parts.entries())
    files[snapshotPartName("models", at + 1)] = {
      rows: part.length,
      ...(await stored(bucket, JSON.stringify(part))),
    };
  const plan = { parts: Object.keys(files), rows: parts.flat().length };
  return saveRelease(bucket, files, sha, "1234", "1", {
    snapshots: { version: 1, kinds: { models: plan } },
  });
}
/** A release from before snapshots had parts: one whole snapshot a kind, in the records' own order. */
async function whole(bucket: R2Bucket, body: string, sha = "e".repeat(40)) {
  return saveRelease(bucket, { "records_models.json": await stored(bucket, body) }, sha, "1234");
}
test("a release replay reuses its content ID, source commit and time and repairs history indexing", async () => {
  const { env } = world();
  const first = await version(env.ARCHIVE, [[{ id: "one", rated: 12 }]]);
  await indexRelease(env.ARCHIVE, first);
  const replay = await version(env.ARCHIVE, [[{ id: "one", rated: 12 }]]);
  assert.deepEqual(replay, first);
  await indexRelease(env.ARCHIVE, replay);
  assert.deepEqual((await releasePage(env.ARCHIVE)).releases, [first]);
  assert.deepEqual(await getRelease(env.ARCHIVE, first.id), first);
});
test("comparison reports additions, removals, nested field changes and bounded matching pages", async () => {
  const { env } = world();
  const from = await version(env.ARCHIVE, [
    [
      { id: "changed", rating: { value: 12, unit: "V" }, source: "manual" },
      { id: "removed", volts: 12 },
    ],
    [{ id: "same", a: 1, b: 2 }],
  ]);
  const to = await version(env.ARCHIVE, [
    [{ id: "added", volts: 24 }],
    [{ id: "changed", rating: { value: 24, unit: "V" }, source: "manual" }],
    [{ b: 2, a: 1, id: "same" }],
  ]);
  const query = { from: from.id, to: to.id, limit: 1 };
  const result = await compareReleases(env.ARCHIVE, CompareQuery.parse(query));
  assert.deepEqual(result.counts, { added: 1, removed: 1, changed: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.changes[0].id, "added");
  assert.equal(result.next, 1);
  const next = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ ...query, offset: result.next }),
  );
  assert.deepEqual(next.changes[0].fields, ["/rating/value"]);
  assert.deepEqual(next.changes[0].before?.rating, { value: 12, unit: "V" });
  const filtered = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ ...query, q: "REMOVED", change: "removed" }),
  );
  assert.equal(filtered.matched, 1);
  assert.equal(filtered.changes[0].change, "removed");
  assert.equal(filtered.next, undefined);
  const identical = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: from.id, to: from.id }),
  );
  assert.equal(identical.total, 0);
  assert.deepEqual(identical.files, []);
});
test("immutable record snapshots survive later publications and reverse comparisons", async () => {
  const { env } = world();
  const first = await version(env.ARCHIVE, [[{ id: "old" }]]);
  const second = await version(env.ARCHIVE, [[{ id: "new" }]]);
  await env.ARCHIVE.put(
    "dataset/v1/records_models_0001.json",
    JSON.stringify([{ id: "unrelated" }]),
  );
  const result = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: second.id, to: first.id }),
  );
  assert.deepEqual(
    result.changes.map((c) => [c.id, c.change]),
    [
      ["new", "removed"],
      ["old", "added"],
    ],
  );
});
test("missing, oversized, repeated and unordered snapshot parts fail explicitly instead of giving a partial diff", async () => {
  const { env } = world();
  const valid = await version(env.ARCHIVE, [[{ id: "ok" }]]);
  const fails = async (release: Release, reason: RegExp) =>
    assert.rejects(
      compareReleases(env.ARCHIVE, CompareQuery.parse({ from: valid.id, to: release.id })),
      reason,
    );
  await fails(await saveRelease(env.ARCHIVE, {}, "b".repeat(40), "1234"), /predates/);
  const planned = (files: Release["files"], parts: string[], rows = 1) =>
    saveRelease(env.ARCHIVE, files, "c".repeat(40), "1234", "1", {
      snapshots: { version: 1, kinds: { models: { parts, rows } } },
    });
  const part = snapshotPartName("models", 1);
  await fails(
    await planned({ [part]: { bytes: SNAPSHOT_PART_MAX + 1, sha256: "b".repeat(64) } }, [part]),
    /exceeds/,
  );
  await fails(await planned({}, [part]), /names a snapshot part it does not list/);
  // Order is held across a part boundary, where neither part alone is wrong.
  await fails(await version(env.ARCHIVE, [[{ id: "same" }], [{ id: "same" }]]), /duplicate/);
  await fails(await version(env.ARCHIVE, [[{ id: "b" }], [{ id: "a" }]]), /out of ID order/);
  await fails(await version(env.ARCHIVE, [[{ id: "b" }, { id: "a" }]]), /out of ID order/);
  const one = { [part]: await stored(env.ARCHIVE, JSON.stringify([{ id: "a" }])) };
  await fails(await planned(one, [part], 2), /parts hold 1 records; the release states 2/);
  const tooMany = Array.from({ length: SNAPSHOT_PART_ROWS + 1 }, (_, i) => ({
    id: `r${String(i).padStart(5, "0")}`,
  }));
  for (const body of ["{", JSON.stringify([{ missingId: true }]), JSON.stringify(tooMany)])
    await fails(
      await planned({ [part]: await stored(env.ARCHIVE, body) }, [part]),
      /malformed or exceeds the 10,000-record limit/,
    );
  await env.ARCHIVE.delete(snapshotKey(valid.files[part].sha256));
  await assert.rejects(
    compareReleases(env.ARCHIVE, CompareQuery.parse({ from: valid.id, to: valid.id })),
    /unavailable/,
  );
});
test("a release published before snapshots had parts still compares with one that has them", async () => {
  const { env } = world();
  const before = await whole(
    env.ARCHIVE,
    JSON.stringify([{ id: "c", watts: 1 }, { id: "a" }, { id: "b", watts: 2 }]),
  );
  const after = await version(env.ARCHIVE, [[{ id: "a" }, { id: "b", watts: 3 }], [{ id: "d" }]]);
  const forward = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: before.id, to: after.id }),
  );
  assert.deepEqual(
    forward.changes.map((c) => [c.id, c.change, c.fields]),
    [
      ["b", "changed", ["/watts"]],
      ["c", "removed", ["/id", "/watts"]],
      ["d", "added", ["/id"]],
    ],
  );
  const backward = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: after.id, to: before.id }),
  );
  assert.deepEqual(backward.counts, { added: 1, removed: 1, changed: 1 });
  const fails = async (release: Release, reason: RegExp) =>
    assert.rejects(
      compareReleases(env.ARCHIVE, CompareQuery.parse({ from: release.id, to: after.id })),
      reason,
    );
  await fails(
    await whole(env.ARCHIVE, JSON.stringify([{ id: "x" }, { id: "y" }, { id: "x" }])),
    /duplicate/,
  );
  await fails(
    await saveRelease(
      env.ARCHIVE,
      { "records_models.json": { bytes: 6 * 1024 * 1024 + 1, sha256: "b".repeat(64) } },
      "b".repeat(40),
      "1234",
    ),
    /exceeds/,
  );
  const fiftyThousandAndOne = Array.from({ length: 50_001 }, (_, i) => ({ id: String(i) }));
  await fails(await whole(env.ARCHIVE, JSON.stringify(fiftyThousandAndOne)), /50,000-record limit/);
});
test("a comparison across many parts of different sizes pairs every record once, in id order", async () => {
  const { env } = world();
  const id = (n: number) => `m${String(n).padStart(3, "0")}`;
  const chunk = <T>(list: T[], size: number) =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
      list.slice(i * size, (i + 1) * size),
    );
  // 0-199 before. After: every fifth removed, every third of the rest rated anew, 200-209 added.
  const before = Array.from({ length: 200 }, (_, n) => ({ id: id(n), rated: n }));
  const after = [
    ...before
      .filter((_, n) => n % 5 !== 0)
      .map((record, i) => (i % 3 === 0 ? { ...record, rated: -1 } : record)),
    ...Array.from({ length: 10 }, (_, k) => ({ id: id(200 + k), rated: 200 + k })),
  ];
  const from = await version(env.ARCHIVE, chunk(before, 7));
  const to = await version(env.ARCHIVE, chunk(after, 11), "b".repeat(40));
  const seen: [string, string][] = [];
  let offset: number | undefined = 0;
  let counts: unknown;
  while (offset !== undefined) {
    const page = await compareReleases(
      env.ARCHIVE,
      CompareQuery.parse({ from: from.id, to: to.id, offset, limit: 50 }),
    );
    counts = page.counts;
    seen.push(...page.changes.map((c): [string, string] => [c.id, c.change]));
    offset = page.next;
  }
  assert.deepEqual(counts, { added: 10, removed: 40, changed: 54 });
  assert.equal(new Set(seen.map(([id]) => id)).size, 104);
  assert.deepEqual(seen.slice(0, 5), [
    ["m000", "removed"],
    ["m001", "changed"],
    ["m004", "changed"],
    ["m005", "removed"],
    ["m008", "changed"],
  ]);
  assert.deepEqual(seen.slice(-2), [
    ["m208", "added"],
    ["m209", "added"],
  ]);
  assert.deepEqual(
    seen.map(([id]) => id),
    seen.map(([id]) => id).sort(),
    "the pages run in id order",
  );
});
test("file comparison includes removed and added files and row/size metadata", async () => {
  const { env } = world();
  const before = await version(env.ARCHIVE, []);
  const files: Release["files"] = {
    ...before.files,
    "models.csv": { sha256: "c".repeat(64), bytes: 12, rows: 1 },
  };
  const after = await saveRelease(env.ARCHIVE, files, "b".repeat(40), "1234", "1", {
    snapshots: before.snapshots,
  });
  const forward = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: before.id, to: after.id }),
  );
  assert.deepEqual(
    forward.files.map((file) => [file.name, file.change, file.after?.rows]),
    [["models.csv", "added", 1]],
  );
  const backward = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: after.id, to: before.id }),
  );
  assert.equal(backward.files[0].change, "removed");
});

test("A to B to A records the revert and a job rerun without copying content or duplicating retries", async (t) => {
  const { env } = world();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-11T08:00:00Z") });
  const a = await version(env.ARCHIVE, [[{ id: "a" }]]);
  await indexRelease(env.ARCHIVE, a);
  t.mock.timers.tick(1000);
  const b = await version(env.ARCHIVE, [[{ id: "b" }]], "b".repeat(40));
  await indexRelease(env.ARCHIVE, b);
  t.mock.timers.tick(1000);
  const reverted = await saveRelease(env.ARCHIVE, a.files, "c".repeat(40), "5678");
  await indexRelease(env.ARCHIVE, reverted);
  assert.equal(reverted.content, a.content);
  assert.notEqual(reverted.id, a.id);
  assert.equal(reverted.sha, "c".repeat(40));
  assert.deepEqual(
    (await releasePage(env.ARCHIVE)).releases.map((release) => release.id),
    [reverted.id, b.id, a.id],
  );
  const events = await activityPage(env.ARCHIVE, ActivityQuery.parse({ kind: "release" }));
  assert.deepEqual(
    events.events.map((event) => event.release),
    [reverted.id, b.id, a.id],
  );
  t.mock.timers.tick(1000);
  const rerun = await saveRelease(env.ARCHIVE, a.files, "c".repeat(40), "5678", "2");
  assert.notEqual(rerun.id, reverted.id);
  await indexRelease(env.ARCHIVE, rerun);
  const retried = await saveRelease(env.ARCHIVE, a.files, "c".repeat(40), "5678", "2");
  await indexRelease(env.ARCHIVE, retried);
  assert.deepEqual(retried, rerun);
  assert.equal((await releasePage(env.ARCHIVE)).releases.length, 4);
});

test("file metadata changes remain visible when the bytes and hash are unchanged", async () => {
  const { env } = world();
  const original = await version(env.ARCHIVE, [[{ id: "one" }]]);
  const part = snapshotPartName("models", 1);
  const changed = await saveRelease(
    env.ARCHIVE,
    { [part]: { ...original.files[part], rows: 2 } },
    "b".repeat(40),
    "9999",
    "1",
    { snapshots: original.snapshots },
  );
  const result = await compareReleases(
    env.ARCHIVE,
    CompareQuery.parse({ from: original.id, to: changed.id }),
  );
  assert.equal(result.total, 0);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].change, "changed");
  assert.equal(result.files[0].before?.rows, 1);
  assert.equal(result.files[0].after?.rows, 2);
});

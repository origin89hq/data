import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompareQuery,
  RECORD_SNAPSHOT_MAX,
  type Release,
} from "@origin89/equipment-schema/releases";
import { digest } from "../src/activity.ts";
import {
  compareReleases,
  getRelease,
  indexRelease,
  releasePage,
  saveRelease,
  snapshotKey,
} from "../src/releases.ts";
import { world } from "./world.ts";

async function version(bucket: R2Bucket, records: unknown[], sha = "a".repeat(40)) {
  const text = JSON.stringify(records),
    hash = await digest(text);
  await bucket.put(snapshotKey(hash), text, { sha256: hash });
  return saveRelease(
    bucket,
    {
      "records_models.json": {
        rows: records.length,
        bytes: new TextEncoder().encode(text).length,
        sha256: hash,
      },
    },
    sha,
    "1234",
  );
}
test("a release replay reuses its content ID, source commit and time and repairs history indexing", async () => {
  const { env } = world();
  const first = await version(env.ARCHIVE, [{ id: "one", rated: 12 }]);
  await indexRelease(env.ARCHIVE, first);
  const replay = await version(env.ARCHIVE, [{ id: "one", rated: 12 }], "b".repeat(40));
  assert.deepEqual(replay, first);
  await indexRelease(env.ARCHIVE, replay);
  assert.deepEqual((await releasePage(env.ARCHIVE)).releases, [first]);
  assert.deepEqual(await getRelease(env.ARCHIVE, first.id), first);
});
test("comparison reports additions, removals, nested field changes and bounded matching pages", async () => {
  const { env } = world();
  const from = await version(env.ARCHIVE, [
    { id: "removed", volts: 12 },
    { id: "changed", rating: { value: 12, unit: "V" }, source: "manual" },
    { id: "same", a: 1, b: 2 },
  ]);
  const to = await version(env.ARCHIVE, [
    { id: "added", volts: 24 },
    { id: "changed", rating: { value: 24, unit: "V" }, source: "manual" },
    { b: 2, a: 1, id: "same" },
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
  const first = await version(env.ARCHIVE, [{ id: "old" }]);
  const second = await version(env.ARCHIVE, [{ id: "new" }]);
  await env.ARCHIVE.put("dataset/v1/records_models.json", JSON.stringify([{ id: "unrelated" }]));
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
test("missing, oversized and duplicate-ID snapshots fail explicitly instead of giving a partial diff", async () => {
  const { env } = world();
  const valid = await version(env.ARCHIVE, [{ id: "ok" }]);
  const absent = await saveRelease(env.ARCHIVE, {}, "b".repeat(40), "1234");
  await assert.rejects(
    compareReleases(env.ARCHIVE, CompareQuery.parse({ from: absent.id, to: valid.id })),
    /predates/,
  );
  const oversized = await saveRelease(
    env.ARCHIVE,
    { "records_models.json": { bytes: RECORD_SNAPSHOT_MAX + 1, sha256: "b".repeat(64) } },
    "b".repeat(40),
    "1234",
  );
  await assert.rejects(
    compareReleases(env.ARCHIVE, CompareQuery.parse({ from: oversized.id, to: valid.id })),
    /exceeds/,
  );
  const duplicate = await version(env.ARCHIVE, [{ id: "same" }, { id: "same" }]);
  await assert.rejects(
    compareReleases(env.ARCHIVE, CompareQuery.parse({ from: duplicate.id, to: valid.id })),
    /duplicate/,
  );
  await env.ARCHIVE.delete(snapshotKey(valid.files["records_models.json"].sha256));
  await assert.rejects(
    compareReleases(env.ARCHIVE, CompareQuery.parse({ from: valid.id, to: valid.id })),
    /unavailable/,
  );
});
test("file comparison includes removed and added files and row/size metadata", async () => {
  const { env } = world();
  const before = await version(env.ARCHIVE, []);
  const files: Release["files"] = {
    ...before.files,
    "models.csv": { sha256: "c".repeat(64), bytes: 12, rows: 1 },
  };
  const after = await saveRelease(env.ARCHIVE, files, "b".repeat(40), "1234");
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

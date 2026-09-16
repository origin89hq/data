import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonical,
  changedFields,
  releaseContent,
  sourceComparison,
} from "@origin89/equipment-schema/releases";

test("field comparison ignores object key order but preserves missing, null, arrays and provenance", () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.deepEqual(changedFields({ name: "X" }, { name: "X", volts: null }), ["/volts"]);
  assert.deepEqual(changedFields({ ports: [1, 2] }, { ports: [2, 1] }), ["/ports"]);
  assert.deepEqual(
    changedFields(
      { evidence: { reviewedBy: "alice", checkedAt: "2026-01-01" } },
      { evidence: { reviewedBy: "bob", checkedAt: "2026-01-01" } },
    ),
    ["/evidence/reviewedBy"],
  );
  assert.deepEqual(changedFields({ "a/b": 1, "~": true }, { "a/b": 2, "~": false }), [
    "/a~1b",
    "/~0",
  ]);
});

test("source comparisons preserve the chosen direction including newer to older", () => {
  const older = "a".repeat(40),
    newer = "b".repeat(40);
  assert.equal(
    sourceComparison(older, newer),
    `https://github.com/origin89hq/offgrid-equipment/compare/${older}..${newer}`,
  );
  assert.equal(
    sourceComparison(newer, older),
    `https://github.com/origin89hq/offgrid-equipment/compare/${newer}..${older}`,
  );
});

test("a release's content is the sha256 of its files with keys sorted, whatever order they came in", async () => {
  const sha = "a".repeat(64);
  const files = {
    "models.csv": { rows: 1, bytes: 14, sha256: sha },
    "specs.csv": { bytes: 9, sha256: sha },
  };
  // Pinned, not recomputed: a publisher and a Worker that drifted apart here would never match.
  const pinned = createHash("sha256")
    .update(
      `{"models.csv":{"bytes":14,"rows":1,"sha256":"${sha}"},"specs.csv":{"bytes":9,"sha256":"${sha}"}}`,
    )
    .digest("hex");
  assert.equal(await releaseContent(files), pinned);
  assert.equal(
    await releaseContent({
      "specs.csv": { sha256: sha, bytes: 9 },
      "models.csv": { sha256: sha, bytes: 14, rows: 1 },
    }),
    pinned,
  );
  for (const changed of [
    { ...files, "models.csv": { ...files["models.csv"], rows: 2 } },
    { ...files, "models.csv": { ...files["models.csv"], sha256: "b".repeat(64) } },
    { "models.csv": files["models.csv"] },
    {},
  ])
    assert.notEqual(await releaseContent(changed), pinned, JSON.stringify(changed));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, changedFields } from "@origin89/equipment-schema/releases";

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

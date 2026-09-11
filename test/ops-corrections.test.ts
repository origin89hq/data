import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CorrectionTarget,
  recordPath,
  reviewCorrection,
  sourceRecord,
} from "../apps/site/src/ops/corrections.ts";

const target: CorrectionTarget = { table: "models", id: "test-model" };
const model = { id: "test-model", manufacturer: "test-maker", name: "Model A" };
const original = `${JSON.stringify(model, null, 2)}\n`;
test("unchanged records create no patch and schema defaults do not invent authored fields", () => {
  const same = reviewCorrection(target, original, JSON.stringify(model));
  assert.deepEqual(same, { ok: true, changed: [], patch: "" });
  const changed = reviewCorrection(target, original, JSON.stringify({ ...model, name: "Model B" }));
  assert.ok(changed.ok);
  assert.deepEqual(changed.changed, ["name"]);
  assert.ok(!changed.patch.includes("aliases"));
  assert.ok(!changed.patch.includes("reviewedBy"));
});
test("invalid JSON, unsupported fields, missing required values and ID renames block export", () => {
  for (const draft of [
    "{",
    JSON.stringify({ ...model, watts: 100 }),
    JSON.stringify({ ...model, name: "" }),
    JSON.stringify({ ...model, id: "another-model" }),
  ])
    assert.equal(reviewCorrection(target, original, draft).ok, false);
  assert.throws(() => recordPath({ ...target, id: "../../secret" }));
});
test("dialect corrections cannot silently move a file to a different family", () => {
  const dialectTarget: CorrectionTarget = {
    table: "dialects",
    family: "ve-direct",
    id: "victron-vedirect-text",
  };
  const raw = readFileSync(recordPath(dialectTarget), "utf8");
  const result = reviewCorrection(
    dialectTarget,
    raw,
    JSON.stringify({ ...JSON.parse(raw), family: "can-bms" }),
  );
  assert.ok(!result.ok);
  assert.match(result.errors.join(" "), /family/);
});
test("exported patches apply to the exact source and reject stale files, with or without a final newline", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ops-patch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "records/models"), { recursive: true });
  for (const raw of [original, original.trimEnd()]) {
    const result = reviewCorrection(target, raw, JSON.stringify({ ...model, name: "Model B" }));
    assert.ok(result.ok);
    writeFileSync(join(dir, recordPath(target)), raw);
    const applied = spawnSync("git", ["apply", "-"], {
      cwd: dir,
      input: result.patch,
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, recordPath(target)), "utf8")).name, "Model B");
    const stale = spawnSync("git", ["apply", "--check", "-"], {
      cwd: dir,
      input: result.patch,
      encoding: "utf8",
    });
    assert.notEqual(stale.status, 0);
  }
});
test("source loading explains generated records, validates IDs and never sends the member session", async (t) => {
  let status = 404;
  let body = model;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.credentials, "omit");
    return Response.json(body, { status });
  });
  await assert.rejects(
    sourceRecord(target, new AbortController().signal),
    /Generated feed records/,
  );
  status = 200;
  body = { ...model, id: "different" };
  await assert.rejects(sourceRecord(target, new AbortController().signal), /ID does not match/);
  body = model;
  assert.deepEqual(JSON.parse(await sourceRecord(target, new AbortController().signal)), model);
});

test("corrections preserve review and extraction metadata, including its absence", () => {
  const specTarget: CorrectionTarget = { table: "specs", id: "test-spec" };
  const spec = {
    id: "test-spec",
    model: "test-model",
    name: "Voltage",
    value: "12",
    source: "manual",
    confidence: "vendor-doc",
    extractedBy: "ai:reader",
    reviewedBy: "original-reviewer",
    checkedAt: "2026-09-10",
  };
  for (const [recordTarget, record] of [
    [target, { ...model, reviewedBy: "original-reviewer", checkedAt: "2026-09-10" }],
    [specTarget, spec],
  ] as const) {
    const raw = JSON.stringify(record);
    for (const key of [
      "reviewedBy",
      "checkedAt",
      ...(recordTarget.table === "specs" ? ["extractedBy"] : []),
    ]) {
      const field = key as keyof typeof record;
      for (const draft of [
        {
          ...record,
          [key]:
            key === "checkedAt"
              ? "2026-09-11"
              : key === "extractedBy"
                ? "table:parser"
                : "someone-else",
        },
        { ...record, [key]: undefined },
      ]) {
        const result = reviewCorrection(recordTarget, raw, JSON.stringify(draft));
        assert.ok(!result.ok);
        assert.match(result.errors.join(" "), /metadata cannot be changed/);
      }
      const absent = JSON.stringify({ ...record, [key]: undefined });
      assert.equal(reviewCorrection(recordTarget, absent, raw).ok, false, `cannot add ${field}`);
    }
    const result = reviewCorrection(
      recordTarget,
      raw,
      JSON.stringify({ ...record, name: "Corrected label" }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.changed, ["name"]);
  }
});

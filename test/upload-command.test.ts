import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { loadRecords } from "../src/records.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "offgrid-upload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const dir = join(root, "input files");
  const calls = join(root, "calls.jsonl");
  mkdirSync(bin);
  mkdirSync(dir);
  const shim = join(bin, "pnpm");
  writeFileSync(
    shim,
    `#!${process.execPath}
    const fs = require('node:fs');
    if (!fs.existsSync('wrangler.jsonc')) throw new Error('Missing Worker config');
    fs.appendFileSync(process.env.UPLOAD_CALLS, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)})+'\\n');
  `,
  );
  chmodSync(shim, 0o755);
  return {
    dir,
    calls: (): { cwd: string; args: string[] }[] =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    run: (script: string, ...flags: string[]) =>
      spawnSync(
        process.execPath,
        [new URL(`../tools/${script}`, import.meta.url).pathname, "--dir", dir, ...flags],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPLOAD_CALLS: calls },
        },
      ),
  };
}
function dataset(dir: string) {
  const bytes = "model\nbattery\n";
  writeFileSync(join(dir, "models.csv"), bytes);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      files: {
        "models.csv": {
          rows: 1,
          bytes: Buffer.byteLength(bytes),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    }),
  );
}
test("dataset upload finds the Worker config from any invoking directory", (t) => {
  const { dir, calls, run } = fixture(t);
  dataset(dir);
  const result = run("dataset/publish.ts");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().length, 2);
  for (const call of calls()) {
    assert.equal(call.cwd, new URL("../apps/worker/", import.meta.url).pathname.replace(/\/$/, ""));
    assert.ok(call.args.includes("--remote"));
    assert.ok(call.args[call.args.indexOf("--file") + 1].startsWith(dir));
  }
});
test("dataset dry-run never invokes the upload command", (t) => {
  const { dir, calls, run } = fixture(t);
  dataset(dir);
  const result = run("dataset/publish.ts", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), []);
  assert.match(result.stdout, /2 files would be published/);
});
test("a dataset with changed bytes is rejected before upload", (t) => {
  const { dir, calls, run } = fixture(t);
  dataset(dir);
  writeFileSync(join(dir, "models.csv"), "model\nchanged\n");
  const result = run("dataset/publish.ts");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha256 disagrees/);
  assert.deepEqual(calls(), []);
});
test("logo upload finds the moved Worker and keeps absolute file arguments", (t) => {
  const { dir, calls, run } = fixture(t);
  const maker = loadRecords().manufacturers.find((item) => item.logo?.widths.length);
  assert.ok(maker?.logo);
  const name = `${maker.id}-${maker.logo.widths[0]}.png`;
  writeFileSync(join(dir, name), "test image bytes");
  const result = run("logos/upload.ts");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().length, 1);
  const call = calls()[0];
  assert.equal(call.cwd, new URL("../apps/worker/", import.meta.url).pathname.replace(/\/$/, ""));
  assert.equal(call.args[call.args.indexOf("--file") + 1], join(dir, name));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "offgrid-just-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(new URL("../justfile", import.meta.url), join(root, "justfile"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const shim = `#!${process.execPath}
    const {spawnSync} = require("node:child_process");
    const args = process.argv.slice(2);
    if (args[0] === "-e") {
      const result = spawnSync(process.execPath, args, {stdio:"inherit", timeout:1000});
      process.exit(result.status ?? 1);
    }
    console.log(JSON.stringify(args));
  `;
  for (const name of ["node", "curl"]) {
    writeFileSync(join(bin, name), shim);
    chmodSync(join(bin, name), 0o755);
  }
  return {
    root,
    run: (...args: string[]) =>
      spawnSync("just", ["--justfile", join(root, "justfile"), ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OFFGRID_BASE_URL: "https://example.invalid",
          OFFGRID_CONTROL_TOKEN: "test-only",
        },
      }),
  };
}

test("maker arguments retain spaces and an empty website", (t) => {
  const { run } = fixture(t);
  const result = run("maker", "acme", "Acme Energy", "", "acme.example");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "tools/gate/decide.ts",
    "maker",
    "acme",
    "Acme Energy",
    "",
    "acme.example",
  ]);
});
test("quoted evidence is passed as data without shell evaluation", (t) => {
  const { run, root } = fixture(t);
  const evidence = 'A "quoted" claim; $(touch injected)';
  const result = run("is", "brand", "maker", evidence);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "tools/gate/decide.ts",
    "is",
    "brand",
    "maker",
    evidence,
  ]);
  assert.equal(existsSync(join(root, "injected")), false);
});
test("approval JSON escapes the approver without changing the request", (t) => {
  const { run, root } = fixture(t);
  const approver = 'A "reviewer" $(touch injected)';
  const result = run("approve", "maker", "2026-09-10", approver, "4");
  assert.equal(result.status, 0, result.stderr);
  const args: string[] = JSON.parse(result.stdout);
  assert.ok(args.includes("https://example.invalid/approve?maker=maker&date=2026-09-10"));
  assert.deepEqual(JSON.parse(args[args.indexOf("--data") + 1]), {
    approved: true,
    approvedBy: approver,
    limit: 4,
  });
  assert.equal(existsSync(join(root, "injected")), false);
});
test("an invalid approval limit sends no request", (t) => {
  const { run } = fixture(t);
  const result = run("approve", "maker", "2026-09-10", "reviewer", "invalid");
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid download limit/);
});

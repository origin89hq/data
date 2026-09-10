import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cases = [
  { name: "accepts identical builds", code: 'writeFileSync("dist/data", "same")', pass: true },
  { name: "rejects changed bytes", code: 'writeFileSync("dist/data", String(run))', pass: false },
  { name: "rejects renamed files", code: 'writeFileSync("dist/data-" + run, "same")', pass: false },
  { name: "rejects empty builds", code: "", pass: false },
  { name: "reports a failed build", code: "process.exit(3)", pass: false },
];
for (const { name, code, pass } of cases) {
  test(name, (t) => {
    const root = mkdtempSync(join(tmpdir(), "offgrid-repeat-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "tools"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    copyFileSync(
      new URL("../tools/build-repeat.ts", import.meta.url),
      join(root, "tools/build-repeat.ts"),
    );
    writeFileSync(
      join(root, "src/build.ts"),
      `
      import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
      const run = existsSync("counter") ? Number(readFileSync("counter", "utf8")) + 1 : 1;
      writeFileSync("counter", String(run));
      rmSync("dist", { recursive: true, force: true });
      mkdirSync("dist");
      ${code};
    `,
    );
    const result = spawnSync(process.execPath, ["tools/build-repeat.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, pass, result.stderr);
    if (pass) assert.match(result.stdout, /Two builds match across 1 files/);
    else assert.match(result.stderr, /Dataset builds differ|produced no files|build failed: 3/);
  });
}

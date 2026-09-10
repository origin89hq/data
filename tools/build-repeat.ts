import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function build() {
  const result = spawnSync(process.execPath, ["src/build.ts"], {
    cwd: root,
    stdio: "inherit",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Dataset build failed: ${result.status ?? result.signal}`);
  return readdirSync(new URL("../dist/", import.meta.url))
    .sort()
    .map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(`../dist/${name}`, import.meta.url)))
        .digest("hex"),
    ]);
}

const first = build();
if (first.length === 0) throw new Error("Dataset build produced no files");
if (JSON.stringify(first) !== JSON.stringify(build())) {
  throw new Error("Dataset builds differ in file names or contents");
}
console.log(`Two builds match across ${first.length} files`);

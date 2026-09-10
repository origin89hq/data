import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { datasetKey, datasetType } from "../../apps/worker/src/runs.ts";

/**
 * Put the built tables where anybody can fetch them.
 *
 * Until this existed the dataset was only ever a build directory that git ignores, which is to say
 * it was not published at all. The Worker serves what this uploads, under `/v1/`, with no token.
 *
 * Every file is checked against the manifest the build wrote before it goes up, because the
 * manifest is what the front door quotes back: a byte count or a hash that disagrees would be the
 * index describing a file that is not there.
 *
 * Usage: publish.ts [--dir dist] [--dry-run]
 */
const args = process.argv.slice(2);
const dir = args.includes("--dir") ? (args[args.indexOf("--dir") + 1] ?? "dist") : "dist";
const dryRun = args.includes("--dry-run");
const run = promisify(execFile);

const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as {
  files: Record<string, { rows: number; bytes: number; sha256: string }>;
};

const onDisk = readdirSync(dir).filter((f) => /\.(parquet|csv|json)$/.test(f));
const disagree: string[] = [];
for (const [name, meta] of Object.entries(manifest.files)) {
  const path = resolve(dir, name);
  const bytes = readFileSync(path);
  if (bytes.length !== meta.bytes)
    disagree.push(`${name}: ${bytes.length} bytes, the manifest says ${meta.bytes}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== meta.sha256) disagree.push(`${name}: sha256 disagrees with the manifest`);
}
if (disagree.length) {
  console.error(
    `the build directory does not match its own manifest; run "just build" first\n  ${disagree.slice(0, 5).join("\n  ")}`,
  );
  process.exit(1);
}

const missing = Object.keys(manifest.files).filter((name) => !onDisk.includes(name));
if (missing.length) {
  console.error(`the manifest names files that are not there: ${missing.slice(0, 5).join(", ")}`);
  process.exit(1);
}

// The manifest goes up too, because the front door reads it to say what it is serving.
const publishing = [...Object.keys(manifest.files), "manifest.json"];
let put = 0;
for (const name of publishing) {
  const path = resolve(dir, name);
  if (dryRun) {
    console.log(`would put ${datasetKey(name)}  ${(statSync(path).size / 1024).toFixed(0)} KB`);
    put += 1;
    continue;
  }
  try {
    await run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `offgrid-equipment-archive/${datasetKey(name)}`,
        "--file",
        path,
        "--content-type",
        datasetType(name),
        "--remote",
      ],
      {
        cwd: new URL("../../apps/worker/", import.meta.url),
        timeout: 60_000,
        maxBuffer: 128 * 1024 * 1024,
      },
    );
  } catch (error) {
    // Wrangler answers a permissions problem with a screenful of account tables and a raw 403,
    // which in CI reads as a broken publish rather than a token missing one scope.
    const said = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
    if (said.includes("403") || said.includes("Authentication error")) {
      console.error(
        `Cloudflare refused to write ${datasetKey(name)}.\n` +
          "The API token can deploy a Worker and cannot write to R2. Add the\n" +
          '"Workers R2 Storage: Edit" permission to the token in CLOUDFLARE_API_TOKEN,\n' +
          "at https://dash.cloudflare.com/profile/api-tokens",
      );
      process.exit(1);
    }
    throw error;
  }
  put += 1;
  if (put % 10 === 0) console.log(`  ${put} of ${publishing.length}`);
}

console.log(`${put} files ${dryRun ? "would be published" : "published"} to /v1/`);
if (!dryRun) console.log(`check it: curl -s https://data.origin89.com/ | head -c 400`);

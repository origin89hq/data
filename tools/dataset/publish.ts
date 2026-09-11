import { createHash } from "node:crypto";
import { openAsBlob, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { datasetKey } from "../../apps/worker/src/runs.ts";
import { inActionsJob, jobToken } from "../credential.ts";
import { requireReleaseHistory } from "./ready.ts";

/**
 * Put the built tables where anybody can fetch them.
 *
 * Until this existed the dataset was only ever a build directory that git ignores, which is to say
 * it was not published at all. The Worker serves what this uploads, under `/v1/`, with no token.
 *
 * Every file is checked against the manifest the build wrote before it goes up, because the
 * manifest is what the front door quotes back: a byte count or a hash that disagrees would be the
 * index describing a file that is not there. The Worker checks again as it writes, and takes the
 * manifest, sent last, only once every file it names is stored as it says.
 *
 * Only publish.yml on main can write. Each request carries a token GitHub issued to that job, and
 * the Worker accepts nothing else here, so this runs in that job, or anywhere with --dry-run.
 *
 * Usage: publish.ts [--dir dist] [--dry-run]
 */
const args = process.argv.slice(2);
const dir = args.includes("--dir") ? (args[args.indexOf("--dir") + 1] ?? "dist") : "dist";
const dryRun = args.includes("--dry-run");
const base = (process.env.OFFGRID_BASE_URL || "https://data.origin89.com").replace(/\/$/, "");
/** specs.csv is tens of megabytes; a stalled upload should fail the job, not hold it. */
const PUT_TIMEOUT_MS = 5 * 60_000;

const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as {
  files: Record<string, { rows?: number; bytes: number; sha256: string }>;
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

if (dryRun) {
  // The manifest goes up too, last, because the front door reads it to say what it is serving.
  for (const name of [...Object.keys(manifest.files), "manifest.json"])
    console.log(
      `would put ${datasetKey(name)}  ${(statSync(resolve(dir, name)).size / 1024).toFixed(0)} KB`,
    );
  console.log(`${Object.keys(manifest.files).length + 1} files would be published to /v1/`);
  process.exit(0);
}

async function put(name: string, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(`${base}/v1/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${await jobToken()}`, ...headers },
    // A blob reads from disk as it is sent, and tells fetch its length, which R2 needs up front.
    body: await openAsBlob(resolve(dir, name)),
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`${base} refused ${name}: HTTP ${response.status} ${await response.text()}`);
}

if (!inActionsJob()) {
  console.error(
    "publishing needs a GitHub Actions token, so it runs in publish.yml, which has id-token: write.\n" +
      "Run with --dry-run to see what would go up.",
  );
  process.exit(1);
}

try {
  await requireReleaseHistory(base);
  const files = Object.entries(manifest.files);
  for (const [name, meta] of files) {
    await put(name, { "x-content-sha256": meta.sha256 });
    console.log(`put ${name}`);
  }
  await put("manifest.json");
  console.log(`${files.length + 1} files published to ${base}/v1/`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

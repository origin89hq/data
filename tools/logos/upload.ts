import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { loadRecords } from "../../src/records.ts";
import { logoKey } from "../../src/logos.ts";

/**
 * Put the gathered logos in the archive, where the Worker serves them without a token.
 *
 * The bytes do not go in the repository. A logo is a trademark rather than a work anybody can
 * license, and shipping the files under MIT would tell every reader they may do as they like with
 * marks that are not ours to give away. The records carry the address and the provenance; the
 * archive carries the image.
 *
 * Usage: upload.ts [--dir <dir>] [--dry-run]
 */
const args = process.argv.slice(2);
const dir = args.includes("--dir") ? (args[args.indexOf("--dir") + 1] ?? "dist/logos") : "dist/logos";
const dryRun = args.includes("--dry-run");
const run = promisify(execFile);

const records = loadRecords();
const expected = new Map<string, string>();
for (const maker of records.manufacturers) {
  for (const width of maker.logo?.widths ?? []) expected.set(`${maker.id}-${width}.png`, logoKey(maker.id, width));
}

const onDisk = new Set(readdirSync(dir).filter((f) => f.endsWith(".png")));
// A file with no record behind it would be served under a name nothing points at.
const orphans = [...onDisk].filter((f) => !expected.has(f));
const missing = [...expected.keys()].filter((f) => !onDisk.has(f));
if (orphans.length) console.log(`${orphans.length} files on disk that no manufacturer record claims, skipped: ${orphans.slice(0, 5).join(", ")}`);
if (missing.length) console.log(`${missing.length} records name a width with no file: ${missing.slice(0, 5).join(", ")}`);

let put = 0;
for (const [file, key] of expected) {
  if (!onDisk.has(file)) continue;
  if (dryRun) {
    console.log(`would put ${key}`);
    put += 1;
    continue;
  }
  // Absolute, because wrangler runs from the Worker's directory and the gathered files may not be
  // under it. Joining ".." onto an absolute path is how the first version of this silently failed.
  await run("pnpm", ["exec", "wrangler", "r2", "object", "put", `offgrid-equipment-archive/${key}`, "--file", resolve(dir, file), "--content-type", "image/png", "--remote"], {
    cwd: "scraper",
    maxBuffer: 64 * 1024 * 1024,
  });
  put += 1;
  if (put % 20 === 0) console.log(`  ${put} of ${expected.size}`);
}

console.log(`${put} logo files ${dryRun ? "would be uploaded" : "uploaded"} for ${records.manufacturers.filter((m) => m.logo).length} manufacturers`);
if (!dryRun) console.log(`check one: curl -sI https://offgrid-equipment-scraper.mashin.workers.dev/${logoKey("victron-energy", 128)}`);

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, FEEDS_DIR } from "../../src/feeds.ts";

/**
 * Check the pinned SAM libraries against what upstream publishes now.
 *
 * A changed dataset is not accepted on sight. It is reported — how many products arrived, left or
 * moved — and the pin only moves with `--accept`. A feed that updated itself would mean the
 * figures published here could change without anybody having looked, which is the thing a pin
 * exists to prevent.
 *
 * Usage: sync-sam.ts [--accept] [--ref <branch or commit>]
 */
const args = process.argv.slice(2);
const accept = args.includes("--accept");
const ref = args[args.indexOf("--ref") + 1] && args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "develop";

const dir = join(FEEDS_DIR, "sam-cec");
const source = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as {
  commit: string;
  retrievedAt: string;
  files: { name: string; sha256: string; kind: string }[];
};

const RAW = (name: string) => `https://raw.githubusercontent.com/NatLabRockies/SAM/${ref}/deploy/libraries/${encodeURIComponent(name)}`;

/** Which products a library holds, by name, so a change can be described rather than just detected. */
function names(text: string): Set<string> {
  const rows = parseCsv(text);
  const at = rows[0]?.indexOf("Name") ?? -1;
  if (at < 0) throw new Error("no Name column; the library's shape changed and the adapter needs looking at");
  return new Set(rows.slice(3).map((r) => r[at]?.trim()).filter((n): n is string => Boolean(n)));
}

let changed = 0;
const staged: { name: string; text: string; sha256: string }[] = [];

for (const file of source.files) {
  const response = await fetch(RAW(file.name), { headers: { "user-agent": "offgrid-equipment (+hello@origin89.com)" } });
  if (!response.ok) {
    console.error(`${file.name}: HTTP ${response.status} from ${RAW(file.name)}`);
    process.exit(1);
  }
  const text = await response.text();
  const sha256 = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  if (sha256 === file.sha256) {
    console.log(`${file.name}: unchanged`);
    continue;
  }
  changed += 1;
  const before = names(readFileSync(join(dir, file.name), "utf8"));
  const after = names(text);
  const added = [...after].filter((n) => !before.has(n));
  const removed = [...before].filter((n) => !after.has(n));
  console.log(`${file.name}: CHANGED`);
  console.log(`  ${before.size} products before, ${after.size} after: ${added.length} added, ${removed.length} removed`);
  for (const n of added.slice(0, 5)) console.log(`    + ${n}`);
  for (const n of removed.slice(0, 5)) console.log(`    - ${n}`);
  if (added.length > 5 || removed.length > 5) console.log(`    …`);
  staged.push({ name: file.name, text, sha256 });
}

if (changed === 0) {
  console.log(`\nthe pin is current against ${ref}`);
  process.exit(0);
}
if (!accept) {
  console.log(`\n${changed} file(s) moved upstream. Look at the change, then accept it with:\n  just sync-sam-accept`);
  process.exit(2);
}

const commit = await fetch(`https://api.github.com/repos/NatLabRockies/SAM/commits/${ref}`, { headers: { accept: "application/vnd.github+json" } })
  .then((r) => (r.ok ? (r.json() as Promise<{ sha: string }>) : undefined))
  .catch(() => undefined);

for (const file of staged) {
  writeFileSync(join(dir, file.name), file.text);
  const entry = source.files.find((f) => f.name === file.name);
  if (entry) entry.sha256 = file.sha256;
}
source.retrievedAt = new Date().toISOString().slice(0, 10);
if (commit?.sha) source.commit = commit.sha;
writeFileSync(join(dir, "source.json"), `${JSON.stringify(source, null, 2)}\n`);
console.log(`\npin moved to ${source.commit.slice(0, 12)} on ${source.retrievedAt}; run the build and read the diff before committing`);

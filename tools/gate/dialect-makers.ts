import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRecords, RECORDS_DIR } from "../../src/records.ts";
import { Dialect } from "../../schema/dialect.ts";

/**
 * Put the maker on each dialect, so a protocol can be joined to a product.
 *
 * It was only ever a prefix on the id. Read as a key it resolves for 232 of 288; the rest name
 * companies this repo holds no manufacturer record for — Generac, Shurflo, Starlink, a dozen
 * generator makers — and those are left absent rather than invented.
 *
 * Usage: dialect-makers.ts [--dry-run]
 */
const dryRun = process.argv.includes("--dry-run");
const records = loadRecords();
const makers = records.manufacturers.map((m) => m.id);

/** Where the catalogue's short form differs from the manufacturer's id by more than a suffix. */
const ALIASES: Record<string, string> = { solark: "sol-ark" };

function makerOf(dialectId: string): string | undefined {
  // Longest wins, so "eg4-electronics" beats "eg4" where both exist.
  const exact = makers.filter((id) => dialectId === id || dialectId.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0];
  if (exact) return exact;
  const head = dialectId.split("-")[0] ?? "";
  if (ALIASES[head]) return ALIASES[head];
  // A prefix that extends to exactly one manufacturer is that manufacturer; two would be a guess.
  const candidates = makers.filter((id) => id === head || id.startsWith(`${head}-`));
  return candidates.length === 1 ? candidates[0] : undefined;
}

let named = 0;
let absent = 0;
const unheld = new Map<string, number>();
for (const dialect of records.dialects) {
  const manufacturer = makerOf(dialect.id);
  if (!manufacturer) {
    absent += 1;
    const head = dialect.id.split("-")[0] ?? "";
    unheld.set(head, (unheld.get(head) ?? 0) + 1);
    continue;
  }
  if (dialect.manufacturer === manufacturer) continue;
  // A dialect lives under its family, which `writeRecord` does not know: writing flat put 245
  // stray files beside the directories they belonged in.
  if (!dryRun) {
    const updated = Dialect.parse({ ...dialect, manufacturer });
    writeFileSync(join(RECORDS_DIR, "dialects", dialect.family, `${dialect.id}.json`), `${JSON.stringify(updated, null, 2)}\n`);
  }
  named += 1;
}

console.log(`${named} dialects given a manufacturer${dryRun ? " (dry run, nothing written)" : ""}`);
console.log(`${absent} left without one, naming companies this repo holds no record for:`);
console.log(`  ${[...unheld].sort((a, b) => b[1] - a[1]).map(([head, n]) => `${head} ${n}`).join(", ")}`);

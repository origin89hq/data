import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { gatherBrands, mergeBrand } from "../../src/gate.ts";
import { readCrawl } from "./archive.ts";
import type { Sighting } from "../../schema/sighting.ts";
import type { Guess } from "../../schema/guess.ts";

/**
 * Fold one or more crawls into the brand queue. Every brand string a seller printed becomes a
 * record: a new one unresolved, an already decided one keeping its decision and taking the fresh
 * evidence. Nothing here decides anything.
 *
 * Usage: queue.ts <date> <seller...> [--remote]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const [date, ...sellers] = args.filter((a) => a !== "--remote");
if (!date || sellers.length === 0) {
  console.error("usage: queue.ts <date> <seller...> [--remote]");
  process.exit(2);
}

const sightings: Sighting[] = [];
const guesses = new Map<string, Guess>();
for (const seller of sellers) {
  const crawl = readCrawl(seller, date, remote);
  if (!crawl) {
    console.error(`${seller}: no crawl at ${date}`);
    process.exit(1);
  }
  if (crawl.missingPages.length) {
    console.error(`${seller}: ${crawl.missingPages.length} pages named by the manifest are missing; refusing a partial queue`);
    process.exit(1);
  }
  sightings.push(...crawl.sightings);
  for (const [k, v] of crawl.guesses) guesses.set(k, v);
  console.log(`${seller}: ${crawl.sightings.length} sightings, ${crawl.guesses.size} classified`);
}

const existing = new Map(loadRecords().brands.map((b) => [b.id, b]));
const found = gatherBrands({ sightings, guesses, seenAt: date });
let added = 0;
let refreshed = 0;
for (const row of found) {
  const before = existing.get(row.id);
  writeRecord(RECORDS_DIR, "brands", row.id, mergeBrand(before, row));
  if (before) refreshed += 1;
  else added += 1;
}
const undecided = found.filter((r) => (existing.get(r.id)?.decision ?? "unresolved") === "unresolved");
console.log(`\n${found.length} brand strings: ${added} new, ${refreshed} refreshed`);
console.log(`${undecided.length} waiting at the gate, ${undecided.filter((r) => r.evidence.inScope > 0).length} of them with an in-scope listing`);

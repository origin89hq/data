import type { Guess } from "@origin89/equipment-schema/guess";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import { gatherBrands, mergeBrand } from "../../src/gate.ts";
import { loadRecords, RECORDS_DIR, writeRecord } from "../../src/records.ts";
import { readCrawl } from "./archive.ts";

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
  const crawl = await readCrawl(seller, date, remote);
  if (!crawl) {
    console.error(`${seller}: no crawl at ${date}`);
    process.exit(1);
  }
  if (crawl.missingParts.length) {
    console.error(
      `${seller}: ${crawl.missingParts.length} classifier parts are not written yet; the evidence would be short, so refusing`,
    );
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
const undecided = found.filter(
  (r) => (existing.get(r.id)?.decision ?? "unresolved") === "unresolved",
);
console.log(`\n${found.length} brand strings: ${added} new, ${refreshed} refreshed`);
console.log(
  `${undecided.length} waiting at the gate, ${undecided.filter((r) => r.evidence.inScope > 0).length} of them with an in-scope listing`,
);

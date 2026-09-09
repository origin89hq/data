import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { deriveModels } from "../../src/models.ts";
import { readCrawl } from "./archive.ts";
import type { Sighting } from "../../schema/sighting.ts";
import type { Guess } from "../../schema/guess.ts";

/**
 * Derive model records from one or more crawls. A listing contributes only when its brand string
 * has been resolved to a manufacturer at the gate, so this runs after the gate and not before.
 *
 * Nothing derived here is reviewed. A model that already carries a reviewer keeps everything a
 * person put on it — the name, the variant, the dialects, the basis — and only its aliases grow.
 *
 * Usage: models.ts <date> <seller...> [--remote] [--dry-run]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const [date, ...sellers] = args.filter((a) => !a.startsWith("--"));
if (!date || sellers.length === 0) {
  console.error("usage: models.ts <date> <seller...> [--remote] [--dry-run]");
  process.exit(2);
}

const sightings: Sighting[] = [];
const guesses = new Map<string, Guess>();
for (const seller of sellers) {
  const crawl = readCrawl(seller, date, remote);
  if (!crawl) {
    console.error(`${seller}: no crawl at ${date}`);
    continue;
  }
  if (crawl.missingPages.length) {
    console.error(`${seller}: ${crawl.missingPages.length} pages missing; refusing a partial derivation`);
    process.exit(1);
  }
  sightings.push(...crawl.sightings);
  for (const [k, v] of crawl.guesses) guesses.set(k, v);
}

const records = loadRecords();
const existing = new Map(records.models.map((m) => [m.id, m]));
const derived = deriveModels({ sightings, guesses, brands: records.brands, dialects: records.dialects });

let added = 0;
let kept = 0;
for (const { model } of derived) {
  const before = existing.get(model.id);
  // A reviewed model is a person's work. Only the alias list grows under it; the name, kind,
  // variant and dialect links stay as they were reviewed.
  const kind = model.kind ?? before?.kind;
  const next = before?.reviewedBy
    ? { ...before, aliases: [...new Set([...before.aliases, ...model.aliases])].sort() }
    : before
      ? {
          ...model,
          // A kind an earlier crawl established survives a later one that ran with no classifier:
          // absence of evidence is not evidence that the kind changed.
          ...(kind ? { kind } : {}),
          aliases: [...new Set([...before.aliases, ...model.aliases])].sort(),
          dialects: [...new Set([...before.dialects, ...model.dialects])].sort(),
        }
      : model;
  if (!dryRun) writeRecord(RECORDS_DIR, "models", model.id, next);
  if (before) kept += 1;
  else added += 1;
}

const withDialect = derived.filter((d) => d.model.dialects.length > 0).length;
const kinds = new Map<string, number>();
for (const d of derived) kinds.set(d.model.kind, (kinds.get(d.model.kind) ?? 0) + 1);
console.log(`${sightings.length} sightings from ${sellers.length} sellers → ${derived.length} models${dryRun ? " (dry run, nothing written)" : `: ${added} new, ${kept} refreshed`}`);
console.log(`${withDialect} join a dialect this repo already documents`);
console.log([...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`).join("\n"));

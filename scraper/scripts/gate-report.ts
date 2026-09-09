import { execFileSync } from "node:child_process";
import { Sighting } from "../../schema/sighting.ts";
import { Guess } from "../../schema/guess.ts";
import { classifierKey } from "../src/classify.ts";

/**
 * What the person at the gate reads: every brand string a seller printed, how many listings
 * carry it, what kinds the model thinks they are, and which maker it proposes. Reads the local
 * R2 store; pass --remote once a bucket is deployed.
 * Usage: gate-report.ts <seller> <date> [--remote] [--all]
 */
const [seller, date, ...flags] = process.argv.slice(2);
if (!seller || !date) {
  console.error("usage: gate-report.ts <seller> <date> [--remote] [--all]");
  process.exit(2);
}
const mode = flags.includes("--remote") ? "--remote" : "--local";
const showAll = flags.includes("--all");
const BUCKET = "offgrid-equipment-archive";

function get(key: string): string | undefined {
  try {
    return execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, mode, "--pipe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}
function readJsonl<T>(prefix: string, pages: number[], parse: (v: unknown) => T): T[] {
  return pages.flatMap((p) => (get(`${prefix}/page-${String(p).padStart(4, "0")}.jsonl`) ?? "").split("\n").filter(Boolean).map((l) => parse(JSON.parse(l))));
}

const sightingsPrefix = `sightings/${seller}/${date}`;
const manifestText = get(`${sightingsPrefix}/manifest.json`);
if (!manifestText) {
  console.error(`no crawl at ${sightingsPrefix}`);
  process.exit(1);
}
const pages = (JSON.parse(manifestText) as { pages: { page: number }[] }).pages.map((p) => p.page);
const sightings = readJsonl(sightingsPrefix, pages, (v) => Sighting.parse(v));

const guessPrefix = `guesses/${seller}/${date}/${classifierKey()}`;
const guessManifest = get(`${guessPrefix}/manifest.json`);
const guesses = new Map<string, Guess>();
if (guessManifest) for (const g of readJsonl(guessPrefix, pages, (v) => Guess.parse(v))) guesses.set(g.productId, g);

interface Row { brand: string; listings: number; kinds: Map<string, number>; makers: Map<string, number>; models: Set<string> }
const rows = new Map<string, Row>();
for (const s of sightings) {
  const brand = s.brand ?? "(no brand)";
  const row = rows.get(brand) ?? { brand, listings: 0, kinds: new Map(), makers: new Map(), models: new Set() };
  row.listings += 1;
  const g = guesses.get(s.productId);
  if (g) {
    row.kinds.set(g.kind, (row.kinds.get(g.kind) ?? 0) + 1);
    if (g.manufacturer) row.makers.set(g.manufacturer, (row.makers.get(g.manufacturer) ?? 0) + 1);
    if (g.model) row.models.add(g.model);
  }
  rows.set(brand, row);
}
const top = (m: Map<string, number>, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");
const inScope = (r: Row) => [...r.kinds.entries()].filter(([k]) => k !== "out-of-scope").reduce((n, [, v]) => n + v, 0);
const sorted = [...rows.values()].sort((a, b) => inScope(b) - inScope(a) || b.listings - a.listings);
const shown = showAll ? sorted : sorted.filter((r) => inScope(r) > 0);

const summary = JSON.parse(guessManifest ?? "{}") as { unanswered?: number };
console.log(`${seller} ${date}: ${sightings.length} sightings, ${rows.size} brand strings, ${guesses.size} classified${summary.unanswered ? `, ${summary.unanswered} unanswered` : ""}`);
console.log(`${shown.length} brands with at least one in-scope listing${showAll ? "" : ` (of ${sorted.length}; --all for the rest)`}\n`);
console.log([`brand as printed`.padEnd(26), "seen".padStart(5), "scope".padStart(6), " kinds".padEnd(46), "maker guess".padEnd(24), "models"].join(" "));
for (const r of shown) {
  console.log([r.brand.slice(0, 26).padEnd(26), String(r.listings).padStart(5), String(inScope(r)).padStart(6), ` ${top(r.kinds).slice(0, 45)}`.padEnd(46), top(r.makers, 1).slice(0, 24).padEnd(24), [...r.models].slice(0, 3).join(", ").slice(0, 60)].join(" "));
}

import { execFileSync } from "node:child_process";
import { Sighting } from "../../schema/sighting.ts";
import { Guess } from "../../schema/guess.ts";

/**
 * What the person at the gate reads: every brand string a seller printed, how many listings
 * carry it, what the model thinks the maker is, and what kinds those listings are. Reads the
 * local R2 store; pass --remote to read the deployed bucket once one exists.
 * Usage: gate-report.ts <seller> <date> [--remote]
 */
const [seller, date, ...flags] = process.argv.slice(2);
if (!seller || !date) {
  console.error("usage: gate-report.ts <seller> <date> [--remote]");
  process.exit(2);
}
const mode = flags.includes("--remote") ? "--remote" : "--local";
const BUCKET = "offgrid-equipment-archive";

function get(key: string): string {
  return execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, mode, "--pipe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function readJsonl<T>(prefix: string, pages: number[], parse: (v: unknown) => T): T[] {
  return pages.flatMap((p) => get(`${prefix}/page-${String(p).padStart(4, "0")}.jsonl`).split("\n").filter(Boolean).map((l) => parse(JSON.parse(l))));
}

const sightingsPrefix = `sightings/${seller}/${date}`;
const manifest = JSON.parse(get(`${sightingsPrefix}/manifest.json`)) as { pages: { page: number }[] };
const pages = manifest.pages.map((p) => p.page);
const sightings = readJsonl(sightingsPrefix, pages, (v) => Sighting.parse(v));

const guessPrefixes = execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "list", BUCKET, "--prefix", `guesses/${seller}/${date}/`, mode], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  .split("\n")
  .map((l) => /(guesses\/[^\s"]+)\/manifest\.json/.exec(l)?.[1])
  .filter((x): x is string => Boolean(x));
const guesses = new Map<string, Guess>();
for (const prefix of guessPrefixes) for (const g of readJsonl(prefix, pages, (v) => Guess.parse(v))) guesses.set(g.productId, g);

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

console.log(`${seller} ${date}: ${sightings.length} sightings, ${guesses.size} guesses from ${guessPrefixes.length} classifier run(s)\n`);
console.log(["brand as printed".padEnd(28), "listings".padStart(8), "in scope".padStart(9), "  kinds", "| maker guess", "| models seen"].join(" "));
for (const r of sorted) {
  if (inScope(r) === 0 && sorted.indexOf(r) > 40) continue;
  console.log([r.brand.slice(0, 28).padEnd(28), String(r.listings).padStart(8), String(inScope(r)).padStart(9), `  ${top(r.kinds)}`, `| ${top(r.makers, 2)}`, `| ${[...r.models].slice(0, 4).join(", ")}${r.models.size > 4 ? ` +${r.models.size - 4}` : ""}`].join(" "));
}

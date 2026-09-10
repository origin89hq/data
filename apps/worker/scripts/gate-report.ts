import { readCrawl } from "../../../tools/gate/archive.ts";

/** Read the gate through the running Worker; --remote requires OFFGRID_BASE_URL. */
const [seller, date, ...flags] = process.argv.slice(2);
if (!seller || !date) {
  console.error("usage: gate-report.ts <seller> <date> [--remote] [--all]");
  process.exit(2);
}
const showAll = flags.includes("--all");
const crawl = await readCrawl(seller, date, flags.includes("--remote"));
if (!crawl) {
  console.error(`${seller}: no crawl at ${date}`);
  process.exit(1);
}
if (crawl.missingParts.length) {
  console.error(`${seller}: incomplete crawl: ${crawl.missingParts.join(", ")}`);
  process.exit(1);
}
const { sightings, guesses } = crawl;

interface Row {
  brand: string;
  listings: number;
  kinds: Map<string, number>;
  makers: Map<string, number>;
  models: Set<string>;
}
const rows = new Map<string, Row>();
for (const s of sightings) {
  const brand = s.brand ?? "(no brand)";
  const row = rows.get(brand) ?? {
    brand,
    listings: 0,
    kinds: new Map(),
    makers: new Map(),
    models: new Set(),
  };
  row.listings += 1;
  const g = guesses.get(`${s.seller}/${s.productId}`);
  if (g) {
    row.kinds.set(g.kind, (row.kinds.get(g.kind) ?? 0) + 1);
    if (g.manufacturer) row.makers.set(g.manufacturer, (row.makers.get(g.manufacturer) ?? 0) + 1);
    if (g.model) row.models.add(g.model);
  }
  rows.set(brand, row);
}
const top = (m: Map<string, number>, n = 3) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
const inScope = (r: Row) =>
  [...r.kinds.entries()].filter(([k]) => k !== "out-of-scope").reduce((n, [, v]) => n + v, 0);
const sorted = [...rows.values()].sort(
  (a, b) => inScope(b) - inScope(a) || b.listings - a.listings,
);
const shown = showAll ? sorted : sorted.filter((r) => inScope(r) > 0);

const unanswered = sightings.filter((s) => !guesses.has(`${s.seller}/${s.productId}`)).length;
console.log(
  `${seller} ${date}: ${sightings.length} sightings, ${rows.size} brand strings, ${guesses.size} classified${unanswered ? `, ${unanswered} unanswered` : ""}`,
);
console.log(
  `${shown.length} brands with at least one in-scope listing${showAll ? "" : ` (of ${sorted.length}; --all for the rest)`}\n`,
);
console.log(
  [
    `brand as printed`.padEnd(26),
    "seen".padStart(5),
    "scope".padStart(6),
    " kinds".padEnd(46),
    "maker guess".padEnd(24),
    "models",
  ].join(" "),
);
for (const r of shown) {
  console.log(
    [
      r.brand.slice(0, 26).padEnd(26),
      String(r.listings).padStart(5),
      String(inScope(r)).padStart(6),
      ` ${top(r.kinds).slice(0, 45)}`.padEnd(46),
      top(r.makers, 1).slice(0, 24).padEnd(24),
      [...r.models].slice(0, 3).join(", ").slice(0, 60),
    ].join(" "),
  );
}

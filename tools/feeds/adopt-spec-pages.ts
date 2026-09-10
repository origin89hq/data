import { readFileSync, writeFileSync } from "node:fs";
import { loadRecords } from "../../src/records.ts";
import { currentRun, object } from "../gate/archive.ts";
import { hostAllowed } from "../../scraper/src/documents.ts";
import { refuses, type Candidate } from "../../src/spec-pages.ts";

/**
 * Take the specification pages a maker's own site turned out to publish and add them to the feed
 * list. Discovery judges every page it already fetched, so what arrives here is evidence — how
 * many products a page describes and how many of its figures carry a unit — rather than a URL
 * somebody typed. Three of the first five typed by hand were wrong.
 *
 * Usage: adopt-spec-pages.ts <manufacturer> <date> [--remote] [--min-figures N] [--min-with-unit N] [--write]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const write = args.includes("--write");
const num = (flag: string, fallback: number) => (args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : fallback);
const minFigures = num("--min-figures", 8);
const minWithUnit = num("--min-with-unit", 3);
const [manufacturer, date] = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
if (!manufacturer || !date) {
  console.error("usage: adopt-spec-pages.ts <manufacturer> <date> [--remote] [--write]");
  process.exit(2);
}

const current = await currentRun("documents", manufacturer, remote);
const body = current ? await object(`documents/${manufacturer}/runs/${current.run}/spec-pages.json`, remote) : undefined;
if (!body) {
  console.error(`no specification pages found for ${manufacturer} at ${date}; run discovery first`);
  process.exit(1);
}
const found = JSON.parse(body) as { pages: Candidate[] };

const maker = loadRecords().manufacturers.find((m) => m.id === manufacturer);
if (!maker) throw new Error(`no manufacturer ${manufacturer}`);

const path = new URL("../../feeds/spec-pages.json", import.meta.url);
const feed = JSON.parse(readFileSync(path, "utf8")) as { note: string; pages: { manufacturer: string; url: string }[] };
const already = new Set(feed.pages.map((p) => p.url));

const refused = new Map<string, string>();
const worth = found.pages.filter((p) => {
  if (already.has(p.url)) return false;
  // A page on a host the maker does not claim is not this maker's page, whatever it says.
  if (!hostAllowed(new URL(p.url).hostname, maker.domains)) return false;
  const why = refuses(p, { minFigures, minWithUnit });
  if (why) refused.set(p.url, why);
  return why === undefined;
});

console.log(`${found.pages.length} pages with a table, ${worth.length} worth adding (at least ${minFigures} figures and ${minWithUnit} with a unit)`);
for (const p of worth.slice(0, 20)) {
  console.log(`  ${String(p.products).padStart(3)} products ${String(p.figures).padStart(4)} figures ${String(p.withUnit).padStart(4)} with a unit  ${p.url.slice(-72)}`);
  console.log(`      ${p.models.slice(0, 4).join(", ")}`);
}
for (const [url, why] of [...refused].slice(0, 12)) console.log(`  refused  ${why}\n           ${url.slice(-72)}`);
if (!write) {
  console.log(`\nnothing written. Add them with --write once the models above look like this maker's products.`);
  process.exit(0);
}
feed.pages = [...feed.pages, ...worth.map((p) => ({ manufacturer, url: p.url }))].sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.url.localeCompare(b.url));
writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`\n${worth.length} added; the feed list now holds ${feed.pages.length}`);

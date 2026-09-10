import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostAllowed } from "@origin89/equipment-schema/documents";
import { loadRecords } from "../src/records.ts";
import { refuses } from "../src/spec-pages.ts";

const pages = (
  JSON.parse(readFileSync(new URL("../feeds/spec-pages.json", import.meta.url), "utf8")) as {
    pages: { manufacturer: string; url: string }[];
  }
).pages;
const records = loadRecords();

test("every specification page belongs to a manufacturer that exists", () => {
  for (const page of pages) {
    assert.ok(
      records.manufacturers.some((m) => m.id === page.manufacturer),
      `${page.manufacturer} is not a manufacturer here`,
    );
  }
});

test("a page's host is one its manufacturer claims, so a page cannot be filed under the wrong maker", () => {
  for (const page of pages) {
    const maker = records.manufacturers.find((m) => m.id === page.manufacturer);
    assert.ok(maker, `Unknown manufacturer: ${page.manufacturer}`);
    const host = new URL(page.url).hostname;
    assert.ok(
      hostAllowed(host, maker.domains),
      `${host} is not a domain ${page.manufacturer} claims`,
    );
  }
});

test("no page is listed twice, and every url is https", () => {
  const urls = pages.map((p) => p.url);
  assert.equal(
    new Set(urls).size,
    urls.length,
    "a page listed twice would be fetched twice for one answer",
  );
  for (const url of urls) assert.equal(new URL(url).protocol, "https:");
});

test("a url is a page and not a document, since a PDF belongs to the approval path", () => {
  for (const page of pages) {
    assert.doesNotMatch(
      new URL(page.url).pathname,
      /\.(pdf|zip|xlsx)$/i,
      `${page.url} is a document; those are fetched only after somebody approves them`,
    );
  }
});

const bar = { minFigures: 8, minWithUnit: 3 };
const candidate = (url: string, figures: number, withUnit: number, models: string[]) => ({
  url,
  products: models.length,
  figures,
  withUnit,
  models,
});

test("a buying guide is refused however many figures it carries, because it is somebody writing about equipment rather than the maker stating it", () => {
  // Bluetti's best candidate: 96 figures, every one with a unit, and still a blog post.
  const guide = candidate("https://www.bluetti.com/blogs/buying-guide/indoor-generators", 96, 96, [
    "AC180",
    "Elite 200 V2",
    "AC300",
  ]);
  assert.match(refuses(guide, bar) ?? "", /article/);
  const post = candidate("https://sigineer.com/2016/07/07/5-dip-switches-functionality/", 20, 6, [
    "TPH 6KW",
  ]);
  assert.match(refuses(post, bar) ?? "", /dated post/);
});

test("a table headed by an attribute or a measurement is refused, since its figures are filed under the wrong thing", () => {
  const category = candidate(
    "https://sigineer.com/product-category/inverter-chargers/three-phase-inverter-charger/",
    35,
    14,
    ["Rated Power", "DC Input", "AC Output 1"],
  );
  assert.match(refuses(category, bar) ?? "", /Rated Power/);
  // NOCO's compatibility matrix: a spec row read as the header row, so GENIUS1 sits beside "2 Amp-Hours".
  const matrix = candidate("https://no.co/support/nlp9", 28, 18, [
    "2 Amp-Hours",
    "25.6 Watt-Hours",
    "GENIUS1",
    "GENIUS5",
  ]);
  assert.match(refuses(matrix, bar) ?? "", /2 Amp-Hours/);
  const switches = candidate("https://sigineer.com/dip/", 20, 6, [
    "Switch Function",
    "Position: 0",
  ]);
  assert.match(refuses(switches, bar) ?? "", /Switch Function/);
});

test("a maker's own product table is adopted", () => {
  const tph = candidate(
    "https://sigineer.com/product/24kw-48v-to-120-208v-3-phase-inverter-charger-pure-sine-wave/",
    208,
    58,
    ["TPH 6KW", "TPH 18KW", "TPH 36KW", "TPH 45KW"],
  );
  assert.equal(refuses(tph, bar), undefined);
  const genius = candidate("https://no.co/support/genius1", 24, 23, [
    "GENIUS1",
    "GENIUS2*",
    "GENIUS5",
    "GENIUS10",
  ]);
  assert.equal(refuses(genius, bar), undefined);
});

test("a page too thin to be worth fetching is refused, and says which bar it missed", () => {
  assert.match(
    refuses(candidate("https://rollsbattery.com/battery/s12-90gel/", 3, 3, ["S12-90GEL"]), bar) ??
      "",
    /only 3 figures/,
  );
  assert.match(
    refuses(candidate("https://sigineer.com/product/avr/", 66, 0, ["100", "110"]), bar) ?? "",
    /carry a unit/,
  );
});

test("no page already adopted is an article or a dated post", () => {
  for (const page of pages) {
    const why = refuses(candidate(page.url, 99, 99, []), bar);
    assert.equal(why, undefined, `${page.url} is ${why}`);
  }
});

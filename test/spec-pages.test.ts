import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRecords } from "../src/records.ts";
import { hostAllowed } from "../scraper/src/documents.ts";

const pages = (JSON.parse(readFileSync(new URL("../feeds/spec-pages.json", import.meta.url), "utf8")) as { pages: { manufacturer: string; url: string }[] }).pages;
const records = loadRecords();

test("every specification page belongs to a manufacturer that exists", () => {
  for (const page of pages) {
    assert.ok(records.manufacturers.some((m) => m.id === page.manufacturer), `${page.manufacturer} is not a manufacturer here`);
  }
});

test("a page's host is one its manufacturer claims, so a page cannot be filed under the wrong maker", () => {
  for (const page of pages) {
    const maker = records.manufacturers.find((m) => m.id === page.manufacturer);
    const host = new URL(page.url).hostname;
    assert.ok(hostAllowed(host, maker!.domains), `${host} is not a domain ${page.manufacturer} claims`);
  }
});

test("no page is listed twice, and every url is https", () => {
  const urls = pages.map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length, "a page listed twice would be fetched twice for one answer");
  for (const url of urls) assert.equal(new URL(url).protocol, "https:");
});

test("a url is a page and not a document, since a PDF belongs to the approval path", () => {
  for (const page of pages) {
    assert.doesNotMatch(new URL(page.url).pathname, /\.(pdf|zip|xlsx)$/i, `${page.url} is a document; those are fetched only after somebody approves them`);
  }
});

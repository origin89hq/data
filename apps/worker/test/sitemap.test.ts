import assert from "node:assert/strict";
import { test } from "node:test";
import type { Seller } from "@origin89/equipment-schema/sighting";
import {
  isIndex,
  locations,
  MAX_URLS,
  pickProducts,
  pickSitemaps,
  sample,
  sitemapUrl,
} from "../src/sitemap.ts";

const seller: Seller = {
  id: "s",
  name: "S",
  url: "https://s.example",
  country: "US",
  currency: "USD",
  platform: "bigcommerce",
};

test("locations are read out of both a urlset and an index, with entities decoded", () => {
  const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://s.example/x.php?type=products&amp;page=1</loc></sitemap></sitemapindex>`;
  assert.equal(isIndex(index), true);
  assert.deepEqual(locations(index), ["https://s.example/x.php?type=products&page=1"]);
  const urlset = `<urlset><url><loc>https://s.example/a</loc></url><url><loc>\n  https://s.example/b\n</loc></url></urlset>`;
  assert.equal(isIndex(urlset), false);
  assert.deepEqual(locations(urlset), ["https://s.example/a", "https://s.example/b"]);
});

test("a location wrapped in CDATA is read literally, since its text is not markup", () => {
  const index = `<sitemapindex><sitemap><loc><![CDATA[https://s.example/post-sitemap.xml]]></loc><lastmod><![CDATA[2026-09-01T05:58:51+00:00]]></lastmod></sitemap></sitemapindex>`;
  assert.deepEqual(locations(index), ["https://s.example/post-sitemap.xml"]);
  const urlset = `<urlset><url><loc><![CDATA[ https://s.example/x.php?a=1&amp;b=2 ]]></loc></url><url><loc>https://s.example/y?a=1&amp;b=2</loc></url><url><loc><![CDATA[]]></loc></url><url><loc><![CDATA[https://[2001:db8::1]/manual.xml]]></loc></url></urlset>`;
  assert.deepEqual(locations(urlset), [
    "https://s.example/x.php?a=1&amp;b=2",
    "https://s.example/y?a=1&b=2",
    "https://[2001:db8::1]/manual.xml",
  ]);
});

test("a seller's own sitemap location wins, since BigCommerce does not serve /sitemap.xml", () => {
  assert.equal(sitemapUrl(seller), "https://s.example/sitemap.xml");
  assert.equal(
    sitemapUrl({ ...seller, sitemapUrl: "https://s.example/xmlsitemap.php" }),
    "https://s.example/xmlsitemap.php",
  );
});

test("only the index entries a seller names are opened, so a crawl does not walk the blog", () => {
  const all = [
    "https://s.example/x.php?type=pages",
    "https://s.example/x.php?type=products&page=1",
    "https://s.example/x.php?type=news",
  ];
  assert.deepEqual(pickSitemaps({ ...seller, sitemapPattern: "type=products" }, all), [all[1]]);
  assert.equal(pickSitemaps(seller, all).length, 3);
});

test("product urls are deduplicated, and a shop bigger than the cap says so instead of shrinking quietly", () => {
  const urls = ["https://s.example/a.html", "https://s.example/a.html", "https://s.example/b"];
  assert.deepEqual(pickProducts({ ...seller, productPattern: "\\.html$" }, urls), {
    urls: ["https://s.example/a.html"],
    capped: false,
  });
  const many = Array.from({ length: MAX_URLS + 5 }, (_, i) => `https://s.example/p${i}`);
  const picked = pickProducts(seller, many);
  assert.equal(picked.urls.length, MAX_URLS);
  assert.equal(picked.capped, true);
});

test("with no pattern every page is tried, because a page that publishes no product yields nothing anyway", () => {
  assert.deepEqual(pickProducts(seller, ["https://s.example/about"]), {
    urls: ["https://s.example/about"],
    capped: false,
  });
});

test("a sample is spread across the shop, because a sitemap lists every category before any product", () => {
  const urls = Array.from({ length: 100 }, (_, i) => `u${i}`);
  const picked = sample(urls, 4);
  assert.deepEqual(picked, ["u0", "u25", "u50", "u75"]);
  assert.equal(sample(urls, 0), urls);
  assert.deepEqual(sample(["a", "b"], 5), ["a", "b"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { sellers } from "../src/sellers.ts";
import { hasFeed } from "../src/feeds.ts";

test("every seller parses, and no two share an id", () => {
  assert.ok(sellers.length > 0);
  assert.equal(new Set(sellers.map((s) => s.id)).size, sellers.length);
});

test("every pattern is a regex that compiles and is not double-escaped into matching nothing", () => {
  for (const s of sellers) {
    for (const [name, pattern] of [["productPattern", s.productPattern], ["sitemapPattern", s.sitemapPattern]] as const) {
      if (!pattern) continue;
      assert.doesNotThrow(() => new RegExp(pattern), `${s.id}: ${name} does not compile`);
      assert.doesNotMatch(pattern, /\\\\/, `${s.id}: ${name} has a doubled backslash, which matched nothing on NAZ and produced a crawl of zero urls`);
    }
  }
});

test("a seller's product pattern matches a url from its own shop", () => {
  const samples: Record<string, string> = {
    nazsolarelectric: "https://www.solar-electric.com/concorde-sunxtender-pvx-340t.html",
  };
  for (const [id, url] of Object.entries(samples)) {
    const seller = sellers.find((s) => s.id === id);
    assert.ok(seller?.productPattern, `${id} has no product pattern`);
    assert.match(url, new RegExp(seller.productPattern), `${id}: pattern does not match a real product url`);
  }
});

test("a seller without a feed carries the sitemap details the page tier needs", () => {
  for (const s of sellers.filter((x) => !hasFeed(x) && x.platform === "bigcommerce")) {
    assert.ok(s.sitemapUrl, `${s.id}: BigCommerce does not serve /sitemap.xml, so a sitemapUrl is required`);
  }
});

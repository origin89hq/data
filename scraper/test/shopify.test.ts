import { test } from "node:test";
import assert from "node:assert/strict";
import { sightingsFromShopify, shopifyPageUrl, type ShopifyProduct } from "../src/shopify.ts";
import { Sighting, type Seller } from "../../schema/sighting.ts";

const seller: Seller = { id: "shop", name: "Shop", url: "https://shop.example/", country: "CA", currency: "CAD", platform: "shopify" };

test("a product with variants becomes one sighting per variant, each carrying its own sku and price", () => {
  const product: ShopifyProduct = {
    id: 7, title: "Rolls S-550", handle: "rolls-s-550", vendor: "Rolls", product_type: "Batteries", tags: ["flooded", "6v"], updated_at: "2026-09-01T10:00:00-04:00",
    variants: [{ title: "6V", sku: "S-550", price: "650.00", available: true }, { title: "Pair", sku: "S-550x2", price: "1250.00", available: false }],
  };
  const s = sightingsFromShopify(seller, [product], "2026-09-09");
  assert.equal(s.length, 2);
  assert.equal(s[0].url, "https://shop.example/products/rolls-s-550");
  assert.equal(s[0].sku, "S-550");
  assert.equal(s[0].extractor, "shopify-feed");
  assert.equal(s[1].variant, "Pair");
  assert.equal(s[1].available, false);
  assert.deepEqual(s[0].tags, ["flooded", "6v"]);
  for (const x of s) Sighting.parse(x);
});

test("a default variant carries no variant label, and empty strings are absent, not empty", () => {
  const product: ShopifyProduct = { id: 1, title: "Thing", handle: "thing", vendor: "", product_type: "", tags: "", variants: [{ title: "Default Title", sku: "", price: "9.99" }] };
  const [s] = sightingsFromShopify(seller, [product], "2026-09-09");
  assert.equal(s.variant, undefined);
  assert.equal(s.brand, undefined);
  assert.equal(s.category, undefined);
  assert.equal(s.tags, undefined);
  assert.equal(s.sku, undefined);
  Sighting.parse(s);
});

test("a product with no variants at all still yields one sighting, so a listing is never lost", () => {
  const s = sightingsFromShopify(seller, [{ id: 2, title: "Bare", handle: "bare" }], "2026-09-09");
  assert.equal(s.length, 1);
  assert.equal(s[0].price, undefined);
  Sighting.parse(s[0]);
});

test("an empty page yields nothing, which is how the crawl knows it is done", () => {
  assert.deepEqual(sightingsFromShopify(seller, [], "2026-09-09"), []);
});

test("comma-separated tags are split and trimmed", () => {
  const [s] = sightingsFromShopify(seller, [{ id: 3, title: "T", handle: "t", tags: "a, b ,c" }], "2026-09-09");
  assert.deepEqual(s.tags, ["a", "b", "c"]);
});

test("the page url asks for the maximum page size and strips a trailing slash from the shop url", () => {
  assert.equal(shopifyPageUrl(seller, 3), "https://shop.example/products.json?limit=250&page=3");
});

test("a sighting with a malformed price or date is refused by the schema", () => {
  const good = sightingsFromShopify(seller, [{ id: 4, title: "T", handle: "t", variants: [{ price: "1.00" }] }], "2026-09-09")[0];
  assert.throws(() => Sighting.parse({ ...good, price: "$1.00" }));
  assert.throws(() => Sighting.parse({ ...good, checkedAt: "yesterday" }));
});

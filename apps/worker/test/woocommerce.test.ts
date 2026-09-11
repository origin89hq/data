import assert from "node:assert/strict";
import { test } from "node:test";
import { type Seller, Sighting } from "@origin89/equipment-schema/sighting";
import {
  minorToDecimal,
  sightingsFromWoo,
  type WooProduct,
  wooPageUrl,
} from "../src/woocommerce.ts";

const seller: Seller = {
  id: "woo",
  name: "Woo",
  url: "https://woo.example",
  country: "CA",
  currency: "CAD",
  platform: "woocommerce",
};

const victron: WooProduct = {
  id: 61844,
  name: "Victron Lynx Power In (M10)",
  slug: "victron-lynx-power-in-m10",
  permalink: "https://woo.example/product/victron-lynx-power-in-m10/",
  sku: "VIC-104-215",
  type: "simple",
  prices: { price: "19610", currency_code: "CAD", currency_minor_unit: 2 },
  brands: [],
  categories: [{ name: "Accessories" }, { name: "Busbars" }],
  tags: [{ name: "LYN020102010" }],
  attributes: [
    { name: "Brand", taxonomy: "pa_brand", terms: [{ name: "Victron" }] },
    { name: "Mnfr. model", taxonomy: "pa_mnfr-model", terms: [{ name: "LYN020102010" }] },
  ],
  is_in_stock: true,
};

test("a store that puts brand and maker's model in attributes yields both, and a minor-unit price becomes a decimal string", () => {
  const [s] = sightingsFromWoo(seller, [victron], "2026-09-09");
  assert.equal(s.brand, "Victron");
  assert.equal(s.model, "LYN020102010");
  assert.equal(s.price, "196.10");
  assert.equal(s.currency, "CAD");
  assert.equal(s.category, "Accessories");
  assert.equal(s.extractor, "woocommerce-feed");
  Sighting.parse(s);
});

test("a brands array wins over the brand attribute, since it is the store's own field", () => {
  const [s] = sightingsFromWoo(
    seller,
    [{ ...victron, brands: [{ name: "Victron Energy" }] }],
    "2026-09-09",
  );
  assert.equal(s.brand, "Victron Energy");
});

test("names come out as the store prints them, not HTML-escaped, and an ampersand of the name's own stays", () => {
  const [s] = sightingsFromWoo(
    seller,
    [
      {
        ...victron,
        // The escapes watts247's feed sends in its names.
        name: "Jinko &gt; 385 Watt 144 Mono PERC Solar Panel &#8211; All Black",
        brands: [{ name: "Jinko &amp; Co" }],
        categories: [{ name: "Panels &amp; Racking" }],
        tags: [{ name: "Mono &#038; Bifacial" }],
        sku: "JKM385M&#8211;72HL4",
        attributes: [{ name: "Model", terms: [{ name: "R&D Plug&notes" }] }],
      },
    ],
    "2026-09-09",
  );
  assert.equal(s.title, "Jinko > 385 Watt 144 Mono PERC Solar Panel – All Black");
  assert.equal(s.brand, "Jinko & Co");
  assert.equal(s.category, "Panels & Racking");
  assert.deepEqual(s.tags, ["Mono & Bifacial"]);
  assert.equal(s.sku, "JKM385M–72HL4");
  assert.equal(s.model, "R&D Plug&notes", "no semicolon, no entity");
  Sighting.parse(s);
});

test("a product with no price, brand, sku or stock flag still yields a sighting with those absent", () => {
  const [s] = sightingsFromWoo(
    seller,
    [{ id: 1, name: "Bare", slug: "bare", permalink: "https://woo.example/product/bare/" }],
    "2026-09-09",
  );
  assert.equal(s.price, undefined);
  assert.equal(s.brand, undefined);
  assert.equal(s.available, undefined);
  assert.equal(s.currency, "CAD");
  Sighting.parse(s);
});

test("a non-integer price string is refused rather than mis-scaled", () => {
  const [s] = sightingsFromWoo(
    seller,
    [{ ...victron, prices: { price: "196.10", currency_minor_unit: 2 } }],
    "2026-09-09",
  );
  assert.equal(s.price, undefined);
});

test("minor units convert without floating point, including sub-unit amounts", () => {
  assert.equal(minorToDecimal("19610", 2), "196.10");
  assert.equal(minorToDecimal("5", 2), "0.05");
  assert.equal(minorToDecimal("1234", 0), "1234");
  assert.equal(minorToDecimal("1234567", 3), "1234.567");
});

test("an empty page yields nothing", () => {
  assert.deepEqual(sightingsFromWoo(seller, [], "2026-09-09"), []);
  assert.equal(
    wooPageUrl(seller, 2),
    "https://woo.example/wp-json/wc/store/v1/products?per_page=100&page=2",
  );
});

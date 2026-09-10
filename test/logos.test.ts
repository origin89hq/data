import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brandOfSlug,
  brandTiles,
  GOOD_ICON,
  iconsInPage,
  logoKey,
  matchTile,
  nameKey,
} from "../src/logos.ts";

// The shape The Cabin Depot actually publishes: the anchor wraps the image, and the alt text is
// the shop's own name on every tile, so the brand is only knowable from the link.
const page = `
<div class="promotion__item promotion__item-image">
  <a href="/collections/epever" aria-label="The Cabin Depot" class="block">
    <div class="media-wrapper">
      <img src="//shop.example/cdn/shop/files/28_b15fd0bc.png?v=1&amp;width=1100" alt="The Cabin Depot" srcset="//shop.example/cdn/shop/files/28_b15fd0bc.png?v=1&amp;width=165 165w">
    </div>
  </a>
</div>
<div class="promotion__item promotion__item-image">
  <a href="/collections/noco" aria-label="The Cabin Depot" class="block">
    <img src="//shop.example/cdn/shop/files/32_8506d836.png?v=2&amp;width=1100" alt="The Cabin Depot">
  </a>
</div>`;

test("each tile's image comes from inside its own link, so a logo cannot land on the wrong brand", () => {
  const tiles = brandTiles(page, "https://shop.example/pages/shop-by-brand");
  assert.deepEqual(
    tiles.map((t) => t.slug),
    ["epever", "noco"],
  );
  assert.equal(tiles[0].image, "https://shop.example/cdn/shop/files/28_b15fd0bc.png?v=1");
  assert.equal(tiles[1].image, "https://shop.example/cdn/shop/files/32_8506d836.png?v=2");
});

test("an image that is not inside a brand link is not a tile", () => {
  // The header logo and a product photo both sit on these pages and belong to neither brand.
  const noise = `<img src="/header.png"><a href="/pages/about"><img src="/about.png"></a>
    <a href="/collections/all/products/thing"><img src="/product.png"></a>`;
  assert.deepEqual(brandTiles(noise, "https://shop.example/x"), []);
});

test("a link with no image is not a tile, and a tile listed twice is one tile", () => {
  const repeated = `<a href="/collections/noco">NOCO</a>
    <a href="/collections/noco"><img src="/a.png"></a>
    <a href="/collections/noco"><img src="/b.png"></a>`;
  assert.deepEqual(brandTiles(repeated, "https://shop.example/x"), [
    { slug: "noco", image: "https://shop.example/a.png" },
  ]);
});

test("a tile is adopted only when it names a manufacturer somebody confirmed", () => {
  // Simple Icons was tried first and its near-matches gave a cryptocurrency's logo for IOTA
  // Engineering and Acura's for Honda, which is why nothing is matched by resemblance.
  const byName = new Map([
    ["epever", "epever"],
    ["victronenergy", "victron-energy"],
  ]);
  assert.equal(matchTile({ slug: "epever", image: "x" }, byName), "epever");
  assert.equal(
    matchTile({ slug: "victron-energy-products", image: "x" }, byName),
    "victron-energy",
  );
  // A shop's category tile sits beside its brand tiles and names no maker.
  assert.equal(matchTile({ slug: "dry-flush-toilets", image: "x" }, byName), undefined);
  assert.equal(matchTile({ slug: "camera-systems", image: "x" }, byName), undefined);
});

test("a slug is reduced to the brand it names", () => {
  assert.equal(brandOfSlug("grundfos-products"), "grundfos");
  assert.equal(brandOfSlug("noco"), "noco");
  // "solar" is part of the company's name, not a suffix to strip.
  assert.equal(brandOfSlug("gma-solar"), "gma-solar");
});

test("a maker's page offers its icons largest first, so the mark beats the favicon", () => {
  const html = `<link rel="icon" href="/favicon.ico" sizes="16x16">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link rel="icon" href="/icon-192.png" sizes="192x192">`;
  assert.deepEqual(
    iconsInPage(html, "https://maker.example/").map((i) => i.url),
    [
      "https://maker.example/icon-192.png",
      "https://maker.example/apple-touch-icon.png",
      "https://maker.example/favicon.ico",
    ],
  );
  assert.deepEqual(iconsInPage("<p>nothing</p>", "https://maker.example/"), []);
});

test("a bare favicon is not good enough to beat a shop's wordmark", () => {
  // Five makers declare nothing but a kilobyte of favicon.ico, which is a tab glyph, not a mark.
  const [only] = iconsInPage(`<link rel="icon" href="/favicon.ico">`, "https://maker.example/");
  assert.ok(only.size < GOOD_ICON, "a favicon with no declared size must not count as a logo");
  const [touch] = iconsInPage(
    `<link rel="apple-touch-icon" href="/t.png">`,
    "https://maker.example/",
  );
  assert.ok(touch.size >= GOOD_ICON, "an apple-touch-icon is the mark a company chose");
});

test("names compare without punctuation or case, and a logo has one key per width", () => {
  assert.equal(nameKey("EG4 Electronics"), nameKey("eg4-electronics"));
  assert.equal(nameKey("Blue Sea Systems"), "blueseasystems");
  assert.equal(logoKey("victron-energy", 128), "logos/victron-energy-128.png");
});

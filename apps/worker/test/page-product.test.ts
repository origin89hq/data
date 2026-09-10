import assert from "node:assert/strict";
import { test } from "node:test";
import { type Seller, Sighting } from "@origin89/equipment-schema/sighting";
import {
  elementInner,
  extractProduct,
  fromJsonLd,
  fromMicrodata,
  modelOf,
  normalisePrice,
  sightingFromPage,
} from "../src/page-product.ts";

const seller: Seller = {
  id: "naz",
  name: "NAZ",
  url: "https://naz.example",
  country: "US",
  currency: "USD",
  platform: "magento",
};

/** The shape a Magento store publishes: one Product node with brand, manufacturer, sku and mpn. */
const magento = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"name":"Home"}}]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Sun Xtender PVX-340T AGM sealed battery","offers":[{"@type":"Offer","priceCurrency":"USD","price":168.42,"availability":"https://schema.org/InStock","seller":{"@type":"Organization","name":"NAZ Solar Electric"}}],"brand":{"@type":"Brand","name":"Concorde Battery"},"manufacturer":{"@type":"Organization","name":"Concorde Battery"},"sku":"PVX-340T","mpn":"PVX-340T"}</script>
</head><body></body></html>`;

/**
 * The shape BigCommerce really publishes, copied from a live page: the breadcrumb trail is a
 * nested scope *inside* the product element and names "Home" first, and the theme prints the
 * brand with its own label. Both of those made the first version of this reader produce a
 * product called "Home" made by "Brand : IntegraRack".
 */
const bigcommerce = `<html><body>
<div itemscope itemtype="http://schema.org/Product">
  <div class="container__inner">
    <ul class="breadcrumbs" itemscope itemtype="http://schema.org/BreadcrumbList">
      <li itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem"><a itemprop="item"><span itemprop="name">Home</span></a><meta itemprop="position" content="1" /></li>
      <li itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem"><a itemprop="item"><span itemprop="name">Solar Ground Mounts</span></a><meta itemprop="position" content="2" /></li>
    </ul>
    <h1 itemprop="name">IntegraRack IR-45ASA Adjustable Seasonal Angle BallastRack</h1>
    <dl><dt>Brand:</dt><dd itemprop="brand" itemscope itemtype="http://schema.org/Brand"><span itemprop="name">IntegraRack</span></dd></dl>
    <span itemprop="sku">IR-45ASA</span>
    <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
      <meta itemprop="price" content="1299.00" />
      <meta itemprop="priceCurrency" content="USD" />
      <link itemprop="availability" href="http://schema.org/InStock" />
    </div>
  </div>
</div></body></html>`;

test("a Magento page yields the product, not the breadcrumb that precedes it in the document", () => {
  const p = fromJsonLd(magento);
  assert.equal(p?.name, "Sun Xtender PVX-340T AGM sealed battery");
  assert.equal(p?.brand, "Concorde Battery");
  assert.equal(p?.manufacturer, "Concorde Battery");
  assert.equal(p?.sku, "PVX-340T");
  assert.equal(p?.price, "168.42");
  assert.equal(p?.currency, "USD");
  assert.equal(p?.availability, true);
});

test("a breadcrumb nested inside the product element does not become the product's name", () => {
  const p = fromMicrodata(bigcommerce);
  assert.equal(p?.name, "IntegraRack IR-45ASA Adjustable Seasonal Angle BallastRack");
  assert.notEqual(p?.name, "Home");
  assert.equal(p?.sku, "IR-45ASA");
  assert.equal(extractProduct(bigcommerce)?.extractor, "micro-data");
});

test("a brand read from a nested Brand scope loses the theme's label, so it can be matched to a manufacturer", () => {
  const p = fromMicrodata(bigcommerce);
  assert.equal(p?.brand, "IntegraRack");
  assert.equal(
    fromMicrodata(
      bigcommerce.replace(
        '<dd itemprop="brand" itemscope itemtype="http://schema.org/Brand"><span itemprop="name">IntegraRack</span></dd>',
        '<dd itemprop="brand">Brand : IntegraRack</dd>',
      ),
    )?.brand,
    "IntegraRack",
  );
});

test("price, currency and availability are read out of a nested Offer scope", () => {
  const p = fromMicrodata(bigcommerce);
  assert.equal(p?.price, "1299.00");
  assert.equal(p?.currency, "USD");
  assert.equal(p?.availability, true);
});

test("an element's extent is counted, so a div inside a div does not close it early", () => {
  const html = `<div id="a"><div id="b">inner</div>tail</div>after`;
  assert.equal(elementInner(html, 0, '<div id="a">', "div"), '<div id="b">inner</div>tail');
  assert.equal(
    elementInner(
      '<meta itemprop="price" content="1">rest',
      0,
      '<meta itemprop="price" content="1">',
      "meta",
    ),
    "",
  );
  assert.equal(elementInner("<div>never closed", 0, "<div>", "div"), undefined);
});

test("a barcode in mpn is not a model number, however confidently the page states it", () => {
  assert.equal(modelOf({ mpn: "990317712768" }), undefined);
  assert.equal(modelOf({ mpn: "PVX-340T", sku: "PVX-340T" }), undefined);
  assert.equal(modelOf({ mpn: "XTRA4210N", sku: "EP-1234" }), "XTRA4210N");
  assert.equal(modelOf({ mpn: "12345", sku: "x" }), "12345", "a short number can still be a model");
});

test("JSON-LD wins where a page publishes both, since it parses exactly", () => {
  assert.equal(extractProduct(magento + bigcommerce)?.extractor, "json-ld");
});

test("a Product nested in an @graph is still found", () => {
  const graph = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Victron SmartSolar MPPT 100/30","sku":"SCC110030210"}]}</script>`;
  assert.equal(fromJsonLd(graph)?.name, "Victron SmartSolar MPPT 100/30");
});

test("a page with no product data yields nothing rather than a sighting made of the page furniture", () => {
  assert.equal(extractProduct("<html><body><h1>About us</h1></body></html>"), undefined);
  assert.equal(
    fromJsonLd(`<script type="application/ld+json">{"@type":"Organization","name":"NAZ"}</script>`),
    undefined,
  );
  assert.equal(
    sightingFromPage(seller, "https://naz.example/about.html", "<html></html>", "2026-09-09"),
    undefined,
  );
});

test("malformed JSON-LD is skipped, not fatal, and a later block still parses", () => {
  const broken = `<script type="application/ld+json">{not json</script>` + magento;
  assert.equal(fromJsonLd(broken)?.sku, "PVX-340T");
});

test("a page sighting keys on the url path, because the page tier has no store id", () => {
  const s = sightingFromPage(
    seller,
    "https://naz.example/concorde-sunxtender-pvx-340t.html",
    magento,
    "2026-09-09",
  );
  assert.equal(s?.productId, "concorde-sunxtender-pvx-340t.html");
  assert.equal(s?.extractor, "json-ld");
  assert.equal(s?.model, undefined, "an mpn equal to the sku is not repeated as a model");
  Sighting.parse(s);
});

test("an mpn that differs from the sku is kept, because it is a model number far more often", () => {
  const s = sightingFromPage(
    seller,
    "https://naz.example/x.html",
    magento.replace('"mpn":"PVX-340T"', '"mpn":"PVX340T-FT"'),
    "2026-09-09",
  );
  assert.equal(s?.model, "PVX340T-FT");
});

test("prices keep their printed form as a plain decimal, and nonsense is absent rather than zero", () => {
  assert.equal(normalisePrice("$1,299.00"), "1299.00");
  assert.equal(normalisePrice(168.42), "168.42");
  assert.equal(normalisePrice("1299"), "1299");
  assert.equal(normalisePrice("Call for pricing"), undefined);
  assert.equal(normalisePrice(""), undefined);
  assert.equal(normalisePrice(undefined), undefined);
});

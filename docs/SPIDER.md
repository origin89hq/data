# The spider

How the list of models grows. A spider with two hops and a person between them:
an open crawler that follows links wherever they go fills the archive with blog
posts and marketplace clones, while a frontier that only grows through a
confirmed manufacturer converges, because the number of brands sold by off-grid
retailers is a few hundred.

## Hop one: sellers to sightings

A committed list of retailers, `scraper/sellers.json`, hand-written and never
extended by the spider. Each is crawled and every product becomes one
**sighting**: brand as printed, title, SKU, variant, price, currency,
availability, the seller's category and tags, the seller's last-modified time,
and the crawl date. A sighting is a fact about the seller. It needs no review
to be stored, and it says nothing about who makes the product.

Two extractors, and every sighting records which one produced it:

1. **A structured feed** where the platform publishes one. Shopify serves
   `products.json`, WooCommerce serves a Store API. Exact, complete, one
   request per hundred products, and it carries fields a page does not: a
   store's own brand and model attributes, every variant with its own price.
2. **The page's own structured data** for the rest. Magento and Shopify emit a
   schema.org `Product` in JSON-LD; BigCommerce emits the same vocabulary as
   microdata. Product URLs come from the sitemap. Both are exact — the reader
   takes what the page states about itself and nothing from its prose, so a
   category page or an article yields nothing, which is the honest answer.

A third tier, a model reading the page's markdown, is for shops that publish
neither. It is not built. When it is, it must be measured against the first two
on a shop that has both before anything trusts it.

**Reading a page correctly is fiddlier than it looks.** A property belongs to
its nearest enclosing scope, and a BigCommerce product element contains the
breadcrumb trail, so a reader that takes the first `name` after the product tag
publishes a product called "Home". A theme prints "Brand : IntegraRack" where
the brand is IntegraRack. A Shopify store puts the barcode in `mpn`, and
"990317712768" is not a model number. All three were found by running the
reader over real pages after it passed its own fixtures, which is the argument
for keeping a real page in the loop.

## The gate: brand to manufacturer

A brand string not yet in the manufacturers table becomes a candidate carrying
the domains the seller's pages linked to. A person confirms the manufacturer,
its website and its aliases, or marks the brand out of scope. This is the only
step that cannot be automated, and it is where duplicate identities are
stopped before they are minted: Rolls, Surrette and Rolls Battery are one
maker, and the AiLi monitor on the shelf is made by Baiway. A model may
propose a kind, a model number and a manufacturer for each brand string; the
person decides.

## Hop two: manufacturer to documents

The confirmed domain is crawled from its sitemap. Every document lands in the
archive under its hash, immutable, with a markdown conversion beside it keyed
by converter and version. Model strings from hop one are matched against
document titles and text, and a match is a candidate `documents` row: this
model, this sheet, this page. It says when one family sheet covers six models
rather than pretending each has its own.

## What runs where

- **A Workflow per seller and per manufacturer**, started weekly. A step that
  fails retries alone, a step that succeeded never re-runs, and an instance
  waiting on a crawl costs nothing. Step results are capped, so steps pass
  storage keys and never page bytes.
- **Fetching** is a plain request per page today, a batch per step, with a
  pause between batches. The crawl endpoint's sitemap discovery, crawl-delay
  and unchanged-since skipping are the upgrade path, and rendering is what a
  shop that builds its pages in the browser will need.
- **R2** holds sightings and documents. A document is served to users only
  when its source record says it may be redistributed; the default is the
  manufacturer's own URL plus our hash and retrieval date.
- **Outside the crawler:** the review, the records, and the build. A model's
  output is a candidate, and it becomes a record when a person attaches the
  source.

## What fails, and how the shape handles it

- **Rebranded generics.** The brand on the shelf is not the manufacturer. Only
  a person catches it, which is what the gate is for.
- **Marketplaces.** No reliable brand or model. Not in the seller list.
- **Discontinued models.** A sighting with no document stays a sighting. It
  still says the model exists and what it cost.
- **Regional variants.** The same name at 120 V and 230 V. The sighting keeps
  the seller's country and the document match keeps the sheet's region.

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

The confirmed domains are read from their sitemaps for links to documents, and
a link that leaves those domains is not one of this maker's. That much only
reads pages the site already publishes to search engines.

**Then it stops.** The instance writes what it *would* fetch — how many
documents, on which hosts, how many bytes where the host said — and waits for a
person to approve it. The approval names who gave it, may narrow the hosts, and
may cap the count. Nothing is fetched without one, and a timeout ends the
instance rather than proceeding: silence is a refusal.

The failure that prevents is a crawl pulling a gigabyte off somebody's server
because a brand resolved at two in the morning. It is also the reason the
instance carries no list of its own — it is created with the domains from a
manufacturer record, and an un-approved instance has nothing to act on.

What is fetched lands in the archive under the SHA-256 of its content, so a
retry rewrites the same object and a document that moved to a new URL is stored
once. A markdown conversion goes beside it, keyed by converter and version.
Model strings from hop one are then matched against document titles and text,
and a match is a candidate `documents` row: this model, this sheet, this page.
It says when one family sheet covers six models rather than pretending each has
its own.

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
- **`waitForEvent`** is what holds hop two open while a person looks at the
  plan. An instance waiting on an event costs nothing and can wait for days.
- **Outside the crawler:** the review, the records, and the build. A model's
  output is a candidate, and it becomes a record when a person attaches the
  source.

## What the reading costs

Turning a PDF into markdown is free while the document has a text layer.
Cloudflare's converter says it is free for most formats and that image
conversion may fall back to Workers AI models for object detection and
summarisation, which is billable — so a scanned manual with no text layer is
the expensive case, and this trade sees plenty of them.

Reading the markdown is the real cost, and it is a 70B model over every window
at $0.293 per million input tokens and $2.253 per million output:

| | |
|---|---|
| A datasheet, about four windows | under a cent |
| 300 documents from one maker | roughly two dollars |
| Every maker at that rate | about a hundred and sixty |

Classifying every model held here, 5,600 of them in batches of ten, is about
sixty cents. So the classifier is free in practice and the reading is not.

An extraction run therefore has a window budget. It stops at the budget, writes
where it stopped, and reports that it stopped early rather than working through
a maker's catalogue unasked — the same reason the download waits for a person.

## What fails, and how the shape handles it

- **Rebranded generics.** The brand on the shelf is not the manufacturer. Only
  a person catches it, which is what the gate is for.
- **Marketplaces.** No reliable brand or model. Not in the seller list.
- **Discontinued models.** A sighting with no document stays a sighting. It
  still says the model exists and what it cost.
- **Regional variants.** The same name at 120 V and 230 V. The sighting keeps
  the seller's country and the document match keeps the sheet's region.

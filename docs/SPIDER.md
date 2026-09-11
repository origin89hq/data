# The spider

How the list of models grows. A spider with two hops and a person between them:
an open crawler that follows links wherever they go fills the archive with blog
posts and marketplace clones, while a frontier that only grows through a
confirmed manufacturer converges, because the number of brands sold by off-grid
retailers is a few hundred.

## Hop one: sellers to sightings

A committed list of retailers, `apps/worker/sellers.json`, hand-written and never
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

The confirmed domains are read from their sitemaps, or from the home page
where a sitemap is missing or lists nothing of theirs, and then one hop further
along the links those pages carry on the same domains, product and download
pages first, all within one page budget. A stale sitemap does not list a
current product page, but the category page it does list links it. A link that
leaves those domains is not one of this maker's. That much only reads pages the
site already publishes, and the plan records what each host and page answered,
so a plan that offers nothing says whether the site refused, moved, or keeps
its documents on a host the record does not claim.

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
  source. A job pulls whatever has been read into one pull request each day, so
  the person's part is reading that diff and merging it; the merge publishes.

## What a second run costs

Almost nothing, and getting there took two corrections.

**A classification is keyed by what was classified, not by when.** The fields a
model is shown — title, brand, SKU, model, category, variant — become the key of
its answer. A weekly crawl of a shop that did not change asks nothing and pays
nothing; only a listing whose text actually moved reaches a model. A price
change is not a reason to ask again.

**A document is read once.** Conversion already skipped what it had, because the
markdown is keyed by the document's content hash. Reading now skips too: a
reading that exists is a reading of exactly those bytes by exactly that
extractor.

**Reading results back was the real bottleneck**, and it was not the pipeline.
The first version fetched one object per request through the wrangler CLI, which
spent about a second of process startup per file — ten minutes to read a run
that took minutes to produce. R2 can list and a Worker can stream, so a run now
comes back in one request: 5,230 answers in a third of a second.

## What the reading costs

Turning a PDF into markdown is free, and for a scan it is free because it does
nothing. Cloudflare's converter extracts a PDF's text and does no OCR, so a
scanned manual comes back as a title, a metadata block and empty page headings.
The text reader reads that, finds nothing, and the document counts as read:
365 approved documents went that way before anybody looked.

Those are read a second way, from their pages. `apps/worker/src/vision.ts` draws
each page with PDFium compiled to WebAssembly, has Kimi K2.7 write the page down
as Markdown, and has it read the figures out of what it wrote. The pages are put
together as a conversion of their own beside `toMarkdown`'s —
`archive/<sha256>.pages-kimi-k2.7-code-p1.md` — so a scan is transcribed once and
can be read again by any later reader without a picture, and a figure can be
checked against its transcription and that against the page. That is under a
cent a page: the expensive case after all, just not where the converter's
documentation suggested. Only a conversion with no text layer is drawn, and a
document too large for PDFium to hold in a Worker's memory is refused in writing
rather than risked.

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

## A run is a thing, not a date

Runs were addressed by the day they happened, and that was wrong in four separate
places before it was fixed properly.

- Two crawls of one maker on one day collided, so I picked a different date for
  the second — which put a day that had not happened into 148 records.
- The workflow instance could not be created twice under the same name, so a
  re-run was simply refused.
- Two runs' readings landed in one directory, where a reader merged the output of
  two different prompts as though it were one answer.
- And "fixing" the dates by moving one run onto another's prefix merged two
  crawls of EPEver into a single directory holding both.

Each of those is the same mistake: an identity doing double duty as a name.

So a run has an id of its own — the date it started, and a suffix that makes two
runs today two runs — and writes only under it. Nothing is cleared, nothing is
overwritten, and a run in progress cannot damage the last good one. A pointer per
seller and per maker says which run is current, and moving that pointer is what
makes a new run take effect.

Readers follow the pointer. None of them may guess from a date, because that is
the mistake in a different chair.

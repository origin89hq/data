# offgrid-equipment

Every model of off-grid equipment worth talking to — charge controllers,
inverters, batteries, BMS, shunts, generators, meters — as one dataset with a
source and a confidence on every fact. Published as Parquet, CSV and JSON so
anything can read it.

**Licence: MIT**, for the tooling, the records and the built artefacts alike
([LICENSE](LICENSE)). Use it for anything, keep the notice. Manufacturer
documents in the archive are their owners' and are not covered; a source
record says whether one may be redistributed, and the default is that it may
not. Bulk feeds keep their own notices when they arrive: SAM's libraries are
BSD-3-Clause.

## What is in it today

The first import is a hand-reviewed protocol catalogue: **288 dialects** across
eight protocol families, citing **554 sources**, with every model each dialect
is known or claimed to cover. A dialect is a register map or frame layout that
owns a driver; a model lands on one only when a source shows matching
addresses. Transport, register blocks and gotchas are carried as the catalogue
wrote them. Splitting them into typed columns is per-row review work and has
not been done.

Not yet in it: the bulk feeds (SAM panels and inverters, the CEC battery list),
per-model ratings, ports as structured rows, and the Origin89 support table.

## Layout

```
records/
  families/<family>.json         the prose around a family's entries, and their order
  dialects/<family>/<id>.json    one dialect: driver, confidence, sources, models, gotchas
  sources/<id>.json              one source: url or path; title, hash and licence once reviewed
schema/                          zod schemas; the enums are the closed vocabularies
src/                             validate, flatten to tables, build the release
tools/catalogue/                 parse and render the catalogue's markdown form
dist/                            built, never committed
```

A record changes in a pull request with a source attached, or it does not
change. Git is the review tool.

## Commands

```sh
pnpm validate            # schema, referential integrity, and a count of what needs a person
pnpm build               # dist/: one CSV and one Parquet per table, dialects.json, sources.json, manifest.json
pnpm test                # node --test
pnpm roundtrip:catalogue <catalogue dir>   # parse and render every family file; must print "same" for each
pnpm import:catalogue    <catalogue dir>   # rewrite records/ from the catalogue
```

`build` needs the `duckdb` CLI for the Parquet files and refuses to run with a
validation error. Two builds of the same records produce identical bytes; the
test suite checks that, because a Parquet writer is not deterministic by
promise.

## The tables

| Table | One row per |
|---|---|
| `dialects` | dialect: family, driver status, confidence, whether a refuter checked it, transport and blocks as prose, the review verdicts |
| `dialect_sources` | citation, in the order the entry lists them |
| `dialect_models` | model named under a dialect, with tier, rating, seller and notes where the catalogue had them |
| `dialect_kinds` | metric a dialect reports or command it accepts |
| `dialect_gotchas` | thing that bites, in order |
| `dialect_see_also` | sibling id an entry may duplicate |
| `sources` | source: url or repository path, plus title, publisher, revision, hash, retrieval date and licence once reviewed |

Absence is an empty cell, never a default. `confidence` is one of `vendor-doc`,
`community-crosschecked`, `community-single`, `unverified`; the last must not be
built on. `refuter` says whether a second pass tried to knock the entry down.
`shared_map_claim_dropped` is true where the refuter found the models were
grouped because an agent proposed it, not because a source showed matching
addresses.

## The round trip

`tools/catalogue` parses the eight family files into records and renders them
back. The render is byte-identical to the source for all eight, which is the
proof that the records hold everything the prose held. Once the catalogue is
regenerated from these records instead of edited by hand, the render becomes
the generator and the parser becomes a migration tool to delete.

## What a person has to look at

`pnpm validate` ends with a count of review items. After the first import:

- every source lacks a title and a licence decision;
- 51 sources are cited by title alone and have no url or path;
- 164 dialects are `unverified`, 122 were never refuted, 98 were refuted, and
  75 lost their model grouping on review;
- 16 dialects are flagged as a possible duplicate of a sibling id.

None of these block the build. They are the work.

## The spider

`scraper/` is a Cloudflare Worker running hop one of the spider described in
[docs/SPIDER.md](docs/SPIDER.md), over the 39 Canadian and US sellers in the
committed `scraper/sellers.json`.

- **`SellerCrawl`** walks a shop's product feed, a page per step, for the 32
  sellers on Shopify or WooCommerce.
- **`PageCrawl`** discovers product URLs from the sitemap and reads each page's
  own JSON-LD or microdata, for the 7 on BigCommerce, Magento or neither.
- **`ClassifySightings`** reads a finished crawl back and asks Workers AI, ten
  listings per step, what each one is.
- **`ManufacturerCrawl`** is hop two: it finds the documents a maker publishes,
  writes what it would fetch, and waits for a person to approve it.

Each writes to R2 as JSONL with a manifest last, so a reader that finds a
manifest knows the run finished. A weekly cron starts one instance per seller;
a second trigger the same day is refused as a duplicate rather than run twice.

A sighting is the listing as printed — brand, title, SKU, variant, price,
category, tags, the seller's last-modified time and the crawl date — and needs
no review to be stored. Resolving a brand string to a manufacturer is the gate
a person keeps, and nothing crawls a manufacturer's site until it is confirmed.

```sh
cd scraper
pnpm types && pnpm test              # generate binding types, unit tests
pnpm dev                             # local Worker with a local R2; AI runs against Cloudflare
curl -X POST 'localhost:8787/run?seller=thecabindepot'
curl -X POST 'localhost:8787/run?seller=nazsolarelectric&limit=40'   # a spread sample, for trying a seller
curl -X POST 'localhost:8787/classify?seller=thecabindepot&date=<date>'
curl 'localhost:8787/status?id=thecabindepot-<date>'
```

Nothing is deployed and no bucket exists yet. Local runs so far:

| Seller | Tier | Result |
|---|---|---|
| The Cabin Depot | Shopify feed | 2,971 sightings, 2,226 products, 131 brand strings |
| Solacity | WooCommerce feed | 493 sightings, 51 brands, 429 with a maker's model number |
| Signature Solar | microdata | 49 of 50 sampled pages |
| NAZ Solar Electric | JSON-LD | 38 of 40 sampled pages |

Most of the Cabin Depot's catalogue is wood stoves and composting toilets, and
that is expected: the seller list is about where off-grid buyers shop, and the
gate is where the energy brands get picked out.

### Reading the gate

`scraper/scripts/gate-report.ts` prints what a person needs to resolve brand
strings into manufacturers: every brand a seller printed, how many listings
carry it, what kinds the classifier thinks they are, and the model numbers it
read off the titles.

```sh
cd scraper
pnpm gate solacity 2026-09-09          # brands with at least one in-scope listing
pnpm gate solacity 2026-09-09 --all    # including the ones that look out of scope
```

A guess is never a fact. It lives beside the sightings under the classifier's
id, so a second model or a changed prompt writes a second set and the two can
be compared before either is trusted.

## The gate

Between the two hops sits the one step a model does not get to take: deciding
which company stands behind a brand string a seller printed. Nothing crawls a
manufacturer's site until that is answered, so a reseller's own label and a
rebadged generic cannot quietly become a maker.

```sh
pnpm gate:queue 2026-09-09 solacity thecabindepot   # fold crawls into the queue
pnpm gate list                                       # what is waiting, most in-scope first
pnpm gate show ep-solar                              # one entry with its evidence
pnpm gate maker epever "EPEver" https://www.epever.com epever.com
pnpm gate is ep-solar epever                         # this brand is made by that company
pnpm gate skip lodge "cookware"                      # not equipment this database covers
```

`queue` never decides anything. A brand new to it arrives `unresolved` and a
brand already answered keeps its answer and takes the fresh evidence, so the
queue is a backlog under version control rather than a list that regrows every
week. The classifier's proposed manufacturer is carried as evidence for the
reviewer and is never written as the answer: a record decided with no named
reviewer, or with a model named as the reviewer, fails validation.

`records/manufacturers/` holds the companies. A manufacturer's `domains` are
what hop two is allowed to crawl, so a reseller's domain does not go in one.

## Approving a document crawl

Hop two reads a maker's sitemap for document links, writes the plan, and stops.

```sh
curl -X POST 'localhost:8787/maker?id=victron-energy&domains=victronenergy.com&pages=40'
wrangler r2 object get offgrid-equipment-archive/documents/victron-energy/<date>/plan.json --local --pipe
curl -X POST 'localhost:8787/approve?id=maker-victron-energy-<date>'   -H 'content-type: application/json'   -d '{"approved":true,"approvedBy":"David","limit":50}'
```

Nothing is fetched until that event arrives. A refusal, an approval naming no
host that was found, and no answer at all all end the run having downloaded
nothing. An approval can narrow what discovery found and can never widen it,
and one with no named approver is refused at the door.

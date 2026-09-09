# offgrid-equipment

Every model of off-grid equipment worth talking to — charge controllers,
inverters, batteries, BMS, shunts, generators, meters — as one dataset with a
source and a confidence on every fact. Published as Parquet, CSV and JSON so
anything can read it. Working title; the name is not settled.

**Licence: not yet decided.** Nothing here is released until it is. The
recommendation on the table is CC BY 4.0 for the records and artefacts and MIT
for the tooling; a non-commercial clause would stop the people most likely to
send corrections back.

## What is in it today

The first import is the origin89 equipment catalogue: **288 dialects** across
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
tools/catalogue/                 parse and render the origin89 catalogue markdown
dist/                            built, never committed
```

A record changes in a pull request with a source attached, or it does not
change. Git is the review tool.

## Commands

```sh
pnpm validate            # schema, referential integrity, and a count of what needs a person
pnpm build               # dist/: one CSV and one Parquet per table, dialects.json, sources.json, manifest.json
pnpm test                # node --test
pnpm roundtrip:catalogue <origin89>/docs/catalog   # parse and render every family file; must print "same" for each
pnpm import:catalogue    <origin89>/docs/catalog   # rewrite records/ from the catalogue
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

`scraper/` is a Cloudflare Worker with one Workflow, `SellerCrawl`: hop one of
the spider described in origin89's `docs/ideas/EQUIPMENT-DB.md`. Given a seller
from the committed `scraper/sellers.json` and a date, it walks the shop's
product feed a page per step, writes each page of sightings to R2 as JSONL, and
writes a manifest last so a reader that finds one knows the run finished. A
weekly cron starts one instance per seller; a second trigger the same day is
refused as a duplicate rather than run twice.

A sighting is the listing as printed — brand, title, SKU, variant, price,
category, tags, the seller's last-modified time and the crawl date — and needs
no review to be stored. Resolving a brand string to a manufacturer is the gate
a person keeps, and nothing crawls a manufacturer's site until it is confirmed.

```sh
cd scraper
pnpm types && pnpm test           # generate binding types, unit tests
pnpm dev                          # local Worker on :8787 with a local R2
curl -X POST 'localhost:8787/run?seller=thecabindepot'
curl 'localhost:8787/status?id=thecabindepot-<date>'
wrangler r2 object get offgrid-equipment-archive/sightings/thecabindepot/<date>/manifest.json --local --pipe
```

Nothing is deployed. The first local run against the Cabin Depot returned
2,971 sightings across 2,226 products and 131 brand strings, most of them wood
stoves and composting toilets. That is expected: the seller list is about where
off-grid buyers shop, and the gate is where the energy brands get picked out.

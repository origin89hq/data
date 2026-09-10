# offgrid-equipment

Every model of off-grid equipment worth talking to — charge controllers,
inverters, batteries, BMS, shunts, generators, meters — as one dataset with a
source and a confidence on every fact. Published as Parquet, CSV and JSON so
anything can read it.

**Licence: MIT**, for the tooling, the records and the built artefacts alike
([LICENSE](LICENSE)). Use it for anything, keep the notice. Manufacturer
documents in the archive are their owners' and are not covered; a source
record says whether one may be redistributed, and the default is that it may
not. Bulk feeds keep their own notices; SAM's libraries are
BSD-3-Clause.

## Data and evidence

The dataset joins equipment models, rated figures, protocol dialects,
manufacturers, and source documents. Authored records and imported feeds keep
their provenance and review state. The [published index](https://data.origin89.com/manifest.json)
reports current row counts and file hashes; `src/tables.ts` defines the exports.

A dialect is a register map or frame layout. A model belongs to one only when
a source supports matching addresses. Missing values stay absent, and imported
or extracted claims do not become human-reviewed evidence automatically.

## Layout

```
records/
  families/<family>.json         the prose around a family's entries, and their order
  dialects/<family>/<id>.json    one dialect: driver, confidence, sources, models, gotchas
  sources/<id>.json              one source: url or path; title, hash and licence once reviewed
packages/schema/src/             shared Zod schemas; the enums are the closed vocabularies
src/                             validate, flatten to tables, build the release
tools/catalogue/                 parse and render the catalogue's markdown form
apps/site/                       React site
apps/worker/                     Cloudflare crawler and public data endpoints
dist/                            built, never committed
```

A record changes in a pull request with a source attached, or it does not
change. Git is the review tool.

## Commands

`just` lists everything, with a line each saying what it is for.

```sh
just check                     # what CI runs: both test suites, validation, two builds compared
just gate                      # what is waiting for a person, most in-scope first
just is ep-solar epever "XTRA2210N matches the dialect the catalogue documents"
just sync-sam                  # is the pinned dataset still what upstream publishes?
just dev                       # the Worker locally, with a local R2
just discover rolls-battery rollsbattery.com 2026-09-09
just plan rolls-battery 2026-09-09        # read it before approving it
just approve rolls-battery 2026-09-09 "David" 40
just convert rolls-battery 2026-09-09     # each document then enqueues its own reading
just specs rolls-battery 2026-09-09
```

Set `OFFGRID_BASE_URL` and `OFFGRID_CONTROL_TOKEN` and the same recipes drive
the deployed spider; without them they talk to `just dev` on this machine.

The catalogue migration keeps its own commands, since it runs once:

```sh
pnpm roundtrip:catalogue <catalogue dir>   # parse and render every family file; must print "same" for each
pnpm import:catalogue    <catalogue dir>   # rewrite records/ from the catalogue
```

`build` needs the `duckdb` CLI for the Parquet files and refuses to run with a
validation error. Two builds of the same records produce identical bytes; the
test suite checks that, because a Parquet writer is not deterministic by
promise.

## Models and their ratings

`records/models/` is what everything else joins to: one record per product a
manufacturer makes, keyed by maker so two companies can both have an "X-1".
Models are derived from the crawls — a listing contributes only when its brand
string has been resolved at the gate, because a model with no owner is a
string — and a derived model carries no reviewer until somebody checks it
against the maker's own document.

```sh
pnpm models 2026-09-11 solacity thecabindepot --dry-run   # see what a crawl would yield
pnpm models 2026-09-11 solacity thecabindepot             # write the records
```

The filter is deliberately strict, because a seller's model field is often just
the title again. "Estate Lawn Seed 25 lbs" arrived in this repo as a model
number, which is the case the rule is written against: a name wrongly rejected
is a row somebody can add, while a sentence wrongly accepted is a product that
does not exist and that a later reader has to disprove.

A model's `kind` is absent until something classifies it. That is a real
answer, not a gap to fill with a default: 5,889 of the current models came from
crawls no classifier had run over, and calling them all balance-of-system would
have been a guess wearing the shape of a fact.

## Reading a maker's datasheets

Hop two ends in figures. Once a manufacturer's documents are archived, two more
Workflows finish the job:

```sh
curl -X POST 'localhost:8787/convert?id=rolls-battery&date=<date>'   # PDFs to markdown
curl -X POST 'localhost:8787/extract?id=rolls-battery&date=<date>'   # markdown to readings
pnpm specs:pull rolls-battery <date> --dry-run                        # see what would land
pnpm specs:pull rolls-battery <date>                                  # write the figures
```

A figure is attached only when the document's own name for the product answers
to a model held for that maker. A product the maker names and no shop we
crawled sells becomes a model first, because a datasheet naming
"S48-300LFP STACK-LV" is better evidence that the product exists than a listing
is. Nothing extracted is confirmed: a spec row names the model that read it, and
validation refuses one that is neither extracted nor reviewed.

Two things the first real run taught. Rolls' lithium datasheet converts to 1,497
characters of scrambled chart labels, because its ratings are pictures and not
text — a maker's catalogue is not uniformly readable and the conversion index
records which documents were. And the figures came out of a UL test report
instead, which is where the ratings for that range are actually tabulated.

`records/specs/` holds the ratings, one row per figure rather than a column per
field. A battery and an inverter share almost no columns, and a single
`capacity_ah` would have to pick one discharge rate and lie — the Rolls S-550
is 428 Ah at the 20-hour rate and 556 Ah at the 100-hour rate, which is two
rows each carrying its own conditions. Every figure names its source, the page
it was read from, and how much weight it carries. The table is empty: filling
it is the next piece of work, and the numbers come from the archived
datasheets rather than from a product title.

## Public feeds

Some products come from a dataset that already states its figures with their
units, and reading those is worth more per row than anything taken out of a PDF.
`feeds/` holds each one redistributed with its licence and pinned by hash; a
changed file fails the pin rather than quietly becoming a different dataset.

Twenty-five thousand rows are not twenty-five thousand records. What is reviewed
is the adapter and the pin, and the build regenerates the rows every time, so
they never enter `records/` and never need a reviewer.

| Feed | Licence | Products | Figures |
|---|---|---|---|
| SAM component libraries, CEC modules and inverters | BSD-3-Clause | 24,020 | 227,531 |

`just sync-sam` checks the pin against what upstream publishes now. A changed
file is reported — how many products arrived, left or moved — and the pin only
moves with `just sync-sam-accept`. A feed that updated itself would mean the
figures published here could change without anybody having looked.

Every model and every figure carries a `tier`: `reviewed` for what a person
checked, `feed` for a row a public dataset states. A reader that cannot tell
them apart will quote the wrong one, so it is a column and never implied. A feed
attaches to a manufacturer only when its printed name answers to one somebody
confirmed — 762 rows do — and an unknown name stays a name, because minting
makers is the gate's decision.

## The tables

| Table | One row per |
|---|---|
| `dialects` | dialect: family, driver status, confidence, whether a refuter checked it, transport and blocks as prose, the review verdicts |
| `dialect_sources` | citation, in the order the entry lists them |
| `dialect_models` | model named under a dialect, with tier, rating, seller and notes where the catalogue had them |
| `dialect_kinds` | metric a dialect reports or command it accepts |
| `dialect_gotchas` | thing that bites, in order |
| `dialect_see_also` | sibling id an entry may duplicate |
| `models` | product a maker makes, with its kind where something has said, and the aliases other names reach it by |
| `model_dialects` | dialect a model is known to speak, carrying the catalogue's own claim and its confidence |
| `specs` | one rated figure, with its unit, the conditions it holds under, its source and page |
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

`apps/worker/` contains the crawler, archive API, and site server described in
[docs/SPIDER.md](docs/SPIDER.md). The committed seller list selects the shops it
can crawl. Manufacturer discovery lists documents for a person to approve
before download. Classification, conversion, and document reading run through
bounded queue jobs; failed jobs remain visible in the dead-letter queue.

Each crawl has a run ID. Archive readers follow the current pointer and keep
sightings and classifier results within that run. A sighting records what a
seller printed; resolving its brand to a manufacturer remains a review decision.

Run `just test` for local tests and `just dev` to start the Worker. Copy
`apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` and set a local control
token first. The local AI binding calls Cloudflare, so crawler commands can
spend money. Use `just --list` for the available operations; download approval
and deployment are separate commands.

### Reading the gate

`apps/worker/scripts/gate-report.ts` prints what a person needs to resolve brand
strings into manufacturers: every brand a seller printed, how many listings
carry it, what kinds the classifier thinks they are, and the model numbers it
read off the titles. It uses the same archive reader as the queue and model commands.
Run `just dev` for local reads, or set `OFFGRID_BASE_URL` and
`OFFGRID_CONTROL_TOKEN` for a deployment. The supplied date must match the current
crawl; a mismatch or missing archive part stops the report.

```sh
cd apps/worker
pnpm gate solacity 2026-09-09          # brands with at least one in-scope listing
pnpm gate solacity 2026-09-09 --all    # including the ones that look out of scope
```

A guess is never a fact. It lives beside the sightings under the classifier's
id, so a second model or a changed prompt writes a second set and the two can
be compared before either is trusted.

## Deploying

The spider deploys from CI, not from a laptop, and the deploy is manual: it arms
a weekly cron that crawls three dozen shops and can spend money on a model, so
it is a decision somebody makes rather than something a merge does. Run
**Deploy the spider** from the Actions tab on `main`.

It needs, once:

| Where | Name | What |
|---|---|---|
| Repository variable | `CLOUDFLARE_ACCOUNT_ID` | the account the Worker and bucket live in |
| Repository secret | `CLOUDFLARE_API_TOKEN` | Workers Scripts edit, Workers R2 Storage edit, Workers AI read |
| Repository secret | `CONTROL_TOKEN` | a random string; the Worker refuses every control endpoint without it |
| Environment | `offgrid-equipment-production` | where the approval reviewers live, if you want a second pair of eyes on a deploy |

The Worker's config names `CONTROL_TOKEN` under `secrets.required`, so wrangler
generates its binding type and warns in local development when it is missing.
There is no hand-written `Env` to drift from what is actually deployed.

The token goes up with the version, so a first deploy is not circular. Every
endpoint that starts a crawl, spends money or releases a download requires it as
a bearer token, and a Worker with no token set refuses everything rather than
allowing everything — an unset secret is the state a fresh deploy is in.
Rotating means changing the repository secret and deploying again.

```sh
curl -X POST "https://<worker>/run?seller=solacity" -H "authorization: Bearer $CONTROL_TOKEN"
```

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
week.

Every decision names who made it and what settled it, and validation refuses
one that carries neither. A reviewer may be a person or an agent working the
queue; what is refused is the bulk classifier naming itself, because a guess
over a product title is evidence and was never a decision.

Of the first 190 brand strings, 97 resolve to a manufacturer, 85 are out of
scope, and 8 are left unresolved because nobody could name their maker — which
is a real answer and is why the queue has three states rather than two.

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

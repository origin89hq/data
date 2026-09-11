# Origin89 Data

Open equipment data for off-grid systems, with sourced specifications, protocol
dialects, and downloadable datasets.

The dataset covers charge controllers, inverters, batteries, BMS, shunts,
generators, and meters, with a source and confidence on each fact. Browse it at
[data.origin89.com](https://data.origin89.com), or download it as Parquet, CSV,
and JSON.

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
just approve rolls-battery 2026-09-09 40   # recorded as whoever `just login` signed in
just convert rolls-battery 2026-09-09     # each document then enqueues its own reading
just specs rolls-battery 2026-09-09
just specs-ready               # every maker whose run is converted and read; a daily job opens this as a PR
```

Set `OFFGRID_BASE_URL=https://data.origin89.com` and run `just login` once, and
the same recipes drive the deployed spider; without it they talk to `just dev`
on this machine. `just login` signs in with GitHub, and only members of the
`origin89hq/working-group` team get in. The sign-in lasts eight hours.

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
| SAM component libraries, CEC modules and inverters | BSD-3-Clause | 24,020 | 292,546 |

`just sync-sam` checks the pin against what upstream publishes now. A changed
file is reported — how many products arrived, left or moved — and the pin only
moves with `just sync-sam-accept`. A feed that updated itself would mean the
figures published here could change without anybody having looked.

Each pinned file is a row in `sources`, at its commit and with its hash, and a
feed figure cites that file and nothing the file does not contain. Its unit is
the one the library's units row states; that row leaves STC and PTC power
blank, so those figures publish without a unit and doubted, and a consumer that
wants them in watts takes that from SAM's documentation, as the property layer
will. A module's STC figures carry `conditions: STC`, the library's own label
for standard test conditions (PTC is PVUSA test conditions), and its
temperature coefficients are kept in A/K, V/K and %/K. A name the library lists
twice keeps both rows, the second under a `-2` suffix, so every id is unique. A
figure's id is its model and its name, so adding a column moves no other id.

Every model and every figure carries a `tier` that says where it comes from:
`record` for a record in this repository, `feed` for a row a public dataset
states. A reader that cannot tell them apart will quote the wrong one, so it is
a column and never implied.

The tier says nothing about checking. Filter on `reviewed_by` for what a person
confirmed against the document. `extracted_by` names what read the rest: `ai:`
is a model reading prose, usable and unconfirmed, and `table:` is a parser
reading the maker's own specification table. A record merged through a pull
request is not thereby reviewed, and a feed row has neither column. A feed
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
| `model_keys` | name a model answers to, under each name its maker goes by, as the key the one rule gives it |
| `model_dialects` | dialect a model is known to speak, carrying the catalogue's own claim and its confidence |
| `specs` | one rated figure, with its unit, the conditions it holds under, its source and page |
| `properties` | one figure read under a registry key: a number in the key's unit, its conditions as columns, the figure it came from, the rule or column that read it, and its basis |
| `property_gaps` | key a model's figures could not fill, with the reason |
| `property_coverage` | key and kind: how many models the key applies to, how many have a value, and the gaps by reason |
| `sources` | source: url or repository path, plus title, publisher, revision, hash, retrieval date and licence once reviewed |

`model_keys` is how a name is resolved to a model, here and in the API: a key is
the maker's or brand's name followed by the model name, each in Unicode NFKC
form, lower case, with spaces and dashes removed and the maker's own name taken
off the front of the model name. The rule lives in `packages/api` so a consumer
can reproduce it. A key that reaches two models is ambiguous, and stays so.

Absence is an empty cell, never a default. `confidence` is one of `vendor-doc`,
`community-crosschecked`, `community-single`, `unverified`; the last must not be
built on. `refuter` says whether a second pass tried to knock the entry down.
`shared_map_claim_dropped` is true where the refuter found the models were
grouped because an agent proposed it, not because a source showed matching
addresses.

## Normalized properties

A figure is published as printed, which preserves the claim and means nothing
can compare, filter or calculate across makers: a controller's PV open-circuit
limit appears under 53 names, "Max. input voltage" among them, and some are
not numbers. `properties` is the same figures read under one key each, from
the registry in `packages/schema/src/properties.ts` and published as
`properties.json`: `pv.voc.max` is a voltage, in V, one number, for anything
with a PV input, and it limits the `pv-voltage` reading.

Nothing is guessed. A maker's figures reach a key only through a mapping
record under `records/mappings/<manufacturer>.json`, reviewed in a pull
request and scoped to that maker and, where the wording is one document's, to
that document; "Max. input voltage" is the open-circuit limit on Victron's
sheets and may not be elsewhere. The SAM feed maps by column, in code. The
value is read by `src/quantities.ts`, which takes "150 volts DC", "8 - 72
Volts dc", "12/24/48V DC" and "-0,29 %/°C" and refuses a bound, a sentence, a
number with no unit, or a unit outside the key's quantity. Conditions are
structured: a capacity at C20 and at C100 are two rows, and a surge without
its duration is not a surge.

What cannot be filled is a gap with a reason in `property_gaps`: `no-claim`
when no figure was read for the key, `unparsed` when the figures could not be
read as numbers, `needs-conditions` when a value lacks a condition the key
needs or its rule `requires`, `conflict` when two usable values under the same
conditions disagree, in which case both publish with `status = 'conflict'`. A
figure that could not be read beside ones that could is still a gap. `basis`
is the figure's, never the rule's: `reviewed` when a person confirmed it,
`extracted` when only a reader took it from the document, `feed` for a public
dataset's row. `property_coverage` says, per key and kind, how far this
reaches in each release: the models with a value, those of them that are
`partial`, and the gaps by reason.

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
Run `just dev` for local reads, or set `OFFGRID_BASE_URL` and run `just login`
for a deployment. The supplied date must match the current crawl; a mismatch or
missing archive part stops the report.

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
| Environment secret | `GH_APP_CLIENT_SECRET` | a client secret of the Origin89 Data GitHub App; the Worker's `GITHUB_CLIENT_SECRET` |
| Environment | `offgrid-equipment-production` | where the approval reviewers live, if you want a second pair of eyes on a deploy |
| GitHub App | Origin89 Data | owned by and installed on origin89hq; Members read, device flow on, callbacks `https://data.origin89.com/auth/callback` and `http://localhost:8790/auth/callback` |
| Team | `origin89hq/working-group` | who may use the control routes |

The Worker's config names its secret under `secrets.required`, so wrangler
generates its binding type and warns in local development when it is missing.
There is no hand-written `Env` to drift from what is actually deployed. The
secret goes up with the version, so a first deploy is not circular.

No workflow holds a long-lived credential for the Worker; the deploy's
Cloudflare token is for Cloudflare's API. The Worker takes a control token only
on a request addressed to this machine, so one left on the deployed Worker
opens nothing, and the deploy deletes it anyway, since a secret stays on a
Worker until it is removed.

Every endpoint that starts a crawl, spends money or releases a download needs a
member of `origin89hq/working-group`. A terminal sends the token `just login`
stored; a browser signs in at `/auth/login` and carries a cookie. The Worker
checks with GitHub that the token was issued to this app and that its owner is
an active member of the team, and remembers the answer for five minutes, so
removing somebody from the team locks them out within five minutes. A token
somebody gave another app, `gh`'s included, is refused. An approval records the
login GitHub vouched for.

Members manage collection at `https://data.origin89.com/ops`. The workspace
shows the supervisor's latest pass and the current manufacturer and seller runs,
with searchable queues, workflow status, archive files, and CSV exports. Run
snapshots refresh on demand; a failed refresh keeps the last successful snapshot
and its timestamp visible. Anybody else is sent to sign in.

Open a manufacturer run to review its document plan and approve a bounded number
of downloads. The approval targets the reviewed workflow instance and records the
signed-in member. Collection controls start a fresh manufacturer discovery or
seller run after checking that the current workflow is no longer active. Existing
archive files remain available. If a submission's response is lost, inspect a fresh
snapshot before trying again; the workspace never repeats it automatically.

The records workspace queries the published dataset and opens authored JSON files
from the repository for correction. It validates drafts against the shared record
schemas and exports a patch for repository review. IDs and dialect families stay
fixed; reference and evidence checks still run through `just check`. Generated
feed records need a change in their source feed. The published-files view provides
downloads, row counts, sizes, and content hashes.

Only `just dev` has a control token, from `apps/worker/.dev.vars`, and a Worker
with neither a control token nor sign-in configured refuses everything rather
than allowing everything. To try sign-in locally, add `GITHUB_CLIENT_SECRET` to
`.dev.vars` and use Chrome or Firefox, which accept a secure cookie from
`http://localhost`.

### Workflows

A workflow that calls the Worker holds no secret for it. The job asks GitHub
for an OIDC token with the audience `https://data.origin89.com`, and the Worker
takes it only from a job on `main` in this repository, checked by repository and
owner ID, and only from the workflow each route names:

| Workflow | Routes | Started by | Environment |
|---|---|---|---|
| `publish.yml` | `PUT /v1/:file` | a push, by hand, or after a successful Worker deployment | `offgrid-equipment-production` |
| `pull-figures.yml` | `/state`, `/archive`, `/readings` | its schedule, or by hand | any |
| `supervise.yml` | `/supervise`, `/state`, `/vision` | by hand | any |

A pull request never gets in: it runs a workflow as its own branch has it. The
tools ask for a job token themselves when they run in a job with
`id-token: write`, and ask again for each request, since a token lasts minutes.

**Publish the dataset** runs on every push to `main` that changes what the
tables are built from. Each file declares its sha256, and R2 refuses a body
that does not match it. The manifest goes last, and the Worker refuses it
unless every file it names is stored at the size and digest it states.
`just publish --dry-run` lists what would go up; without `--dry-run` the
command works only inside that job.

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
Its `documentHosts` are where its own pages keep their PDFs when that is a
shop's CDN or a CloudFront distribution: a document there is offered only when
a page on the maker's domains links it, and no page there is read. An empty
plan names the hosts a maker's pages linked, which is how you know what to add.

## Approving a document crawl

Hop two reads a maker's sitemap for document links, writes the plan, and stops.

```sh
curl -X POST 'localhost:8787/maker?id=victron-energy&domains=victronenergy.com&pages=40'
wrangler r2 object get offgrid-equipment-archive/documents/victron-energy/<date>/plan.json --local --pipe
curl -X POST 'localhost:8787/approve?id=maker-victron-energy-<date>'   -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json'   -d '{"approved":true,"limit":50}'
```

Nothing is fetched until that event arrives. A refusal, an approval naming no
host that was found, and no answer at all all end the run having downloaded
nothing. An approval can narrow what discovery found and can never widen it,
and it names who gave it: the GitHub login the Worker verified, never a name
the request typed. A `limit` takes the documents the records already cite
first, then the rest in the plan's order, which lists them the same way.

## Activity and dataset versions

The workspace's **Activity feed** records collection starts and outcomes, download
approval decisions, supervisor summaries, and dataset publications. Filters apply
on the server; a sparse page can still have older events to load. Run links name
the archived attempt rather than whichever run is current today. Activity writes
retry independently and log failures without repeating collection work. This is
operational history, not a complete audit log: interrupted or externally
terminated workflows and exhausted history writes can leave gaps.

**Releases & changes** records each publication, including rollbacks to earlier
content, with its verified source commit and job attempt. A content hash identifies
identical datasets; retrying the same job attempt repairs the same publication. Choose two versions and a record type to inspect
additions, removals, changed field paths, before/after records, and file changes.
Record counts refer to authored records; CSV tables can have more rows because
they expand nested claims. Publishing identical content in another job or rerun records a new occurrence.

Beside each table's CSV and Parquet the build writes its rows as newline-delimited
JSON in parts of at most 20,000 rows, `models_0001.ndjson` and so on, and the
manifest's `load` section says which parts make each table. The publish step keeps
every part content-addressed as well, so a loader reading a release by its manifest
reads the bytes that manifest named, whatever was published since (#83).

The build adds `records_<kind>.json` snapshots for the seven authored record
types. Publication keeps these by SHA-256 in R2 and validates their presence before
accepting the manifest. Snapshots are limited to 6 MiB per kind and 50,000 records
per comparison; oversized or missing history is reported explicitly. History
reads require the existing member session. History itself needs no binding beyond R2.

An accepted manifest also starts a `release-load` Workflow, which loads the
release's tables from their content-addressed parts into the `RELEASES` D1
database, one part a step, and makes it the active release once it is the newest
publication loaded. A load that cannot finish leaves the active release as it
was. Every release a fixture names in `apps/worker/pinned-releases.json` stays
loaded, with the active one and the seven most recent; the rest are let go. This
store is what the read-only `EquipmentApi` entrypoint answers from (#83);
`docs/API.md` is the consumer's side of it.

The build also emits `vocabulary.json`: the closed lists a consumer joins on
(metric and command kinds, equipment kinds, dialect families, confidence,
driver status, refuter status, brand decisions, the row tiers, the
dialect-model tiers, a property's basis, status and scope, a gap's reason,
a dialect kind's direction and a model key's origin), taken from `packages/schema` so a firmware crosswalk or
an assistant pins the words with the release rather than copying them.

Publication checks the Worker's history capability before uploading any file.
An automatic publish on an older Worker fails explicitly and leaves the dataset
untouched. A successful manual Worker deployment triggers publication again;
failed deployments do not. History starts with that rollout; older runs are not
backfilled. Retries within a publishing job repair its index without duplicating
the event; a job rerun is a separate publication occurrence.

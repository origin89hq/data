# Where this is, and what to pick up

Written at the end of a long session so the next one does not have to reconstruct it.
Everything below is committed and pushed; `git status` is clean.

## What exists

`data.origin89.com` is live. One Cloudflare Worker (`worker/`) is the entry point: it serves the
React site (`site/`), the published tables, and the makers' marks, and refuses everything else
without the control token.

```
GET /                        the site
GET /manifest.json           what is published: rows, bytes, sha256, URL per file
GET /v1/<table>.parquet|csv|json   the tables, with HTTP range support
GET /logos/<maker>-<width>.png     64, 128, 256
everything else              401 without the bearer
```

| | |
|---|---|
| Models | 6,312 |
| Classified | 6,176 |
| Rated figures | 15,662 |
| Sizing grade (a number with a real unit) | 12,928, or 83% |
| Manufacturers | 86, of which 58 have a logo |
| Protocol dialects | 288 |
| Source documents | 1,265 |

Publishing is automatic: a push to `main` touching `records/`, `feeds/`, `schema/` or `src/`
validates, tests, builds twice and compares, publishes to R2, then fetches `specs.parquet` back and
checks the bytes match. Deploying the Worker stays manual, because it arms the crawler.

## In flight right now

**A classification run under prompt p3.** Every model was pushed and is being classified again;
`alreadyAnswered` was 0, so nothing is cached. When it finishes:

```sh
node tools/gate/pull-kinds.ts --remote     # then validate, build, publish
```

The prompt changed because the classifier was answering `out-of-scope` where it meant it could not
tell. A run under p2 produced 2,543 of them, mostly bare part numbers like "ABB 1666001", which is
a positive claim that two and a half thousand products are furniture. That run is reverted and was
never published. `out-of-scope` now says explicitly that it is a claim about what a product is.

Expect `pull-kinds` to change a lot of answers: the p2 run replaced 2,342. It can also clear a kind
now, which it could not before, so a model the classifier declines loses whatever an older prompt
guessed at it.

One thing p2 did not fix: a NOCO GB70 is a jump starter and the vocabulary has no kind for one. It
moved from `charge-controller` to `inverter-charger`, which is closer and still wrong. That is an
enum decision, not a prompt one.

## The next thing, which was interrupted mid-sentence

**A vision fallback for documents that convert to nothing.** Some approved PDFs are scanned images;
the current reader only sees extracted text, so they produce no figures and sit forever as
"1 of 25 left" in `just status`.

The tracking this needs already exists. A reading is content-addressed at
`archive/<sha256>.<extractor>.reading.json`, so a document is never read twice by the same reader,
and a second reader gets its own key beside the first. Adding a vision reader therefore costs
nothing for the documents already read, and the work is:

1. A new extractor id in `worker/src/reading.ts`, alongside `EXTRACTOR_ID`.
2. A `Work` variant in `worker/src/work.ts` for it, and a case in `worker/src/consumer.ts`.
3. `supervise` should enqueue it only where the text reader produced nothing.
4. `tools/gate/pull-specs.ts` already reads every extractor's file per document; add the id to its
   list.

## Coverage gaps worth naming

- **Rolls Battery**: 23 documents read, none of them a per-model datasheet. Its specifications live
  on HTML product pages the spec-page rule rejects, because their tables are transposed and yield
  three figures each. `rollsbattery.com/battery/s-550/` 404s, so the URL shape differs per product.
- **Volthium**: discovery found no documents at all and its sitemap 404s. 49 models, 0 figures.
- 21 makers show a handful of documents permanently outstanding. Those are the scanned ones above.

## Decisions still open

- **`@origin89/brand` should publish the journal theme.** `site/src/design/website.css` and
  `website-tokens.css` are a copy of the live website's cottage theme, and the only copy in this
  repo. They belong beside `tokens/tailwind.css` and `tokens/themes.css` so every Origin89 surface
  imports one palette. Either a PR against `origin89hq/brand`, or add it there and change one
  import here.
- **A hybrid does more than one job.** An EG4 6000XP is an inverter, a charger and an MPPT
  controller; `kind` can only say `inverter-charger`, so a query for charge controllers misses every
  hybrid. A `functions` array beside `kind` would fix it. Additive, but it changes the published
  schema.
- **`no-comms` dialects say `driver_status: possible`.** 80 of 86 do, with an empty transport. If a
  device has no communications a driver is not possible, so one of those two fields is wrong. Not
  changed, because it is the catalogue's own vocabulary.
- **CEC battery workbook is blocked.** Its terms prohibit commercial use, which MIT grants to
  everyone downstream. The SAM libraries we already ship are fine, being BSD-3. SAM has no battery
  catalogue; it does have 296 wind turbines under the same licence, but only 72 are under 10 kW and
  it needs a new equipment kind.
- **17 duplicate groups are unmerged** because their records disagree about what the product is. A
  Sol-Ark 8K-2P-N is an inverter under one spelling and an inverter-charger under another. That list
  is the best consistency check on the classifier available, and every entry is at least one wrong
  answer. `just merge` prints it.

## How to drive it

```sh
export OFFGRID_BASE_URL=https://data.origin89.com
export OFFGRID_CONTROL_TOKEN=…            # wrangler secret CONTROL_TOKEN

just status                 # what every maker and seller is waiting on
just supervise <date>       # move anything whose precondition is met
just approve <maker> <date> <who> <limit>
just specs <maker> <date> --remote        # figures into records
just merge                  # fold duplicate models, report the disputed
just logos                  # find a mark for every maker
just build-twice && just publish
```

Records live in git; sightings, documents and readings live in R2. `just check` is the gate.

## Things that bit, so they do not again

- A run must remove what it stopped producing. `pull-specs` did not, so tightened rules only ever
  added and stale rows survived three fixes.
- Route order decided who needed a token before Hono; a middleware on `*` then made the site's own
  stylesheet 401. Both are tested now.
- A class the design does not define renders as nothing, silently. `test/site-classes.test.ts`
  walks every `className` in the components.
- `sharp`'s `stats()` reads the input, not the pipeline, so a white-on-transparent logo passed a
  contrast check and published a blank square.
- R2 reports a range on every object, so answering 206 to a request with no `Range` header is easy
  to do by accident.

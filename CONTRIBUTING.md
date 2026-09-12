# Contributing

A record is a claim with a source. A pull request that adds or changes one
carries the source, and the reviewer reads the source, not the diff.

- One dialect per file under `records/dialects/<family>/`, named by its id.
- Every citation points at a record in `records/sources/`. A source with no
  `url` and no `path` is accepted but counted for review; a citation with no
  source at all fails validation.
- A model lands on a dialect only when a source shows matching register
  addresses. Same vendor is not evidence. Same spec-sheet wording is not
  evidence.
- `confidence` is what the sources support, not what you believe. `unverified`
  is an honest answer.
- `reviewedBy` is set only by the person who checked that figure or model
  against its document. A reader's figure carries `extractedBy` instead, and
  merging the pull request that brings it in does not review it. Consumers
  filter on `reviewed_by` for checked facts; the published `tier` only says
  whether a row is a record here or a feed row.
- A mapping record under `records/mappings/<manufacturer>.json` says which of a
  maker's printed names reach which property key, with the sheet's own words as
  its basis. A rule is scoped to one maker, and to one document where the
  wording is that document's; translating a name into English does not make
  two properties the same. `records/mappings/shared.json` is the exception:
  a name goes there only when it says in full what it measures on any sheet,
  and a maker whose sheets use it for something else lists it under `except`.
  Reviewing a rule does not review the figures it reads. Start a maker's file
  from `just mapping-draft <manufacturer>`, read the mapping audit in
  `pnpm validate`, and run `just coverage-snapshot` so the pull request carries
  what the change did to coverage.
- A battery's `chemistry` is set only where the maker's name for it or its
  sheet says so, with `chemistryBasis` naming which, `name` or `spec:<id>`; a pack whose chemistry nothing states has none, and its
  capacity then needs a discharge rate like a lead-acid pack's.
- Absent beats plausible. A baud rate the document does not state stays out of
  the record; write the gap in `gotchas`.
- Run `pnpm validate && pnpm test` before opening the pull request.

## Development setup

Follow the [Origin89 engineering standards](https://github.com/origin89hq/engineering)
for working practices, tests, writing, and commits. `AGENTS.md` loads shared
skills at the start of a task; `just skills-sync` refreshes them from engineering.
Keep local constraints and domain-specific checks alongside those shared rules.

Track confirmed problems left outside the current fix using the
[shared issue rule](https://github.com/origin89hq/engineering/blob/main/skills/origin89-working/SKILL.md#track-unfinished-work).
Use `gh` to find or create the issue, verify it, and return its URL.

Install just 1.58.0 and Python 3.9+ for the skill bootstrap. Run `just --list`
for repository commands and `just check` before opening a pull request.

Use Node 24 LTS and the pnpm version in `package.json`. Install dependencies
with `pnpm install --frozen-lockfile`. Biome checks authored JavaScript and
TypeScript; generated assets keep their existing validators.

Install DuckDB 1.5.5 for Parquet builds. CI downloads the official release and
verifies its checksum in `.github/actions/setup-duckdb`. `just check` runs two
builds in one process and compares their file names and contents.

The CSS cascade groups component styles before responsive overrides. Biome's
`noDescendingSpecificity` comparison crosses unrelated component selectors, so
that rule is disabled for CSS. Formatting and the other CSS rules still apply.

For local Worker commands, copy `apps/worker/.dev.vars.example` to
`apps/worker/.dev.vars` and set your development token. Keep that file untracked.

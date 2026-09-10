# Working in this repository

For hosted PR reviews, follow `Code Review Rules` below without running the local
skills refresh. For other tasks, run `just skills-sync` from the repository root.
Read `skills/origin89-working/SKILL.md` and the relevant domain skills under the
immutable `path` printed by that command. Keep that snapshot for the task; do not
refresh it halfway through work. Before branch, commit, push, or PR operations,
read `skills/origin89-commits/SKILL.md` from that snapshot. Read local instructions
and preserve stronger project constraints and project-specific skills.

If refresh reports cached content, continue with that verified cache and mention
that the script could not check for updates. If no cache is available or
validation fails, report the error; do not claim the shared rules loaded. Local
instructions and the user's request still apply. Do not overwrite local skill
files to fix a conflict without reconciling them.

[Origin89 engineering](https://github.com/origin89hq/engineering) owns the shared
rules. Keep only repository-specific architecture, commands, target constraints,
and exceptions below. Internal RFCs and research belong in
[internal-research](https://github.com/origin89hq/internal-research). Add documentation
only when its value and upkeep are clear; remove AI filler from every message.

## Data and application boundaries

`records/` holds sourced equipment claims, `packages/schema/src/` defines their contracts,
and `src/` validates and builds the dataset. Deployable applications live under
`apps/`. Read `CONTRIBUTING.md` before changing records: missing information
stays missing, and shared vendors do not establish protocol compatibility.

Run `just check` before committing. The gate includes source lint, tests, app
type checks, record validation, and repeatable dataset builds. The DuckDB CLI
is required for Parquet output. Worker binding types come from its Wrangler
configuration. Keep the crawl approval gate, the control and workflow token
checks, and resource bounds intact. Ordinary checks must not invoke remote AI,
approve downloads, publish data, or deploy the scheduled crawler.

## Code Review Rules

Use the shared `origin89-review` skill when it is available in the review context.
Hosted reviews may not have the local skill cache; apply these rules and disclose
missing shared context instead of claiming it loaded.

- Preserve source provenance and review state. Missing values stay absent;
  inferred or extracted claims must not become human-reviewed evidence without
  the documented review. Shared vendors do not prove protocol compatibility.
- Preserve control- and workflow-token checks, crawl approval, and resource
  bounds. A change must not start downloads, spend remote AI credits, publish
  data, or deploy the crawler through ordinary validation or review commands.
- Check schema consumers, invalid inputs, exact limits, and failure paths. Flag
  silent truncation or partial results that callers mistake for complete data.
  Require distinct behavioral tests rather than repeated successful examples.
- Trace a suspected defect through callers and guards before reporting it.
  Give its trigger, consequence, and precise location. Use CI evidence for the
  reviewed head, leave formatting to Biome, and avoid duplicate findings.

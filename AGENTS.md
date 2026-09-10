# Working in this repository

At the start of each new task, run `just skills-sync` from the repository root.
Read `skills/origin89-working/SKILL.md` and the relevant domain skills under the
immutable `path` printed by that command. Keep that snapshot for the task; do not
refresh it halfway through work. Read local instructions and preserve stronger
project constraints and project-specific skills.

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
configuration. Keep the crawl approval gate, control token checks, and resource
bounds intact. Ordinary checks must not invoke remote AI, approve downloads,
publish data, or deploy the scheduled crawler.

# Every command this repository needs, and what each one is for.
# `just` on its own lists them.

set positional-arguments

# Where the spider lives. Unset, everything talks to `just dev` on this machine.
export OFFGRID_BASE_URL := env_var_or_default("OFFGRID_BASE_URL", "")

_default:
    @just --list --unsorted

# ---- the gate: what needs a person ----

# What is waiting at the gate, most in-scope listings first.
gate *args:
    node tools/gate/decide.ts list "$@"

# One brand with all its evidence.
show brand:
    node tools/gate/decide.ts show "$@"

# This brand is made by that company, and why. The basis is not optional.
is brand maker *basis:
    node tools/gate/decide.ts is "$@"

# Not equipment this database covers, and why.
skip brand *reason:
    node tools/gate/decide.ts skip "$@"

# Add a manufacturer. Its domains are what hop two may crawl.
maker id name website="" *domains:
    node tools/gate/decide.ts maker "$@"

# ---- records from crawls ----

# Fold crawls into the brand queue. Decides nothing.
queue date +sellers:
    node tools/gate/queue.ts "$@"

# Derive model records from crawls whose brands the gate has answered.
models date +sellers:
    node tools/gate/models.ts "$@"

# Fold the records that are one product filed several times into one.
merge *args:
    node tools/gate/merge-models.ts "$@"

# Fold the classifier's answers onto models that have no kind.
kinds *args:
    node tools/gate/pull-kinds.ts "$@"

# Set each battery's chemistry from a figure on its sheet or the maker's name for it. Run after `just kinds` and `just specs`; --replace recomputes ones already set.
chemistry *args:
    node tools/gate/pull-chemistry.ts "$@"

# Write spec records from a maker's readings.
specs maker date *args:
    node tools/gate/pull-specs.ts "$@"

# The same for every maker whose run has finished converting and been read. A job does this daily into a PR.
specs-ready *args:
    node tools/gate/pull-ready-specs.ts "$@"

# ---- the spider ----

# Requests keep their localhost address: sign-in builds its GitHub callback from it.
# Run the Worker locally, with a local R2 and the AI binding proxied to Cloudflare.
dev:
    cd apps/worker && pnpm exec wrangler dev --port 8790 --local-upstream localhost:8790

# Crawl one seller.
crawl seller date="" *args:
    @just _post "/run?seller=$1&date=$2$3"

# Classify a finished crawl. Listings already answered cost nothing.
classify seller date:
    @just _post "/classify?seller=$1&date=$2"

# Find what documents a maker publishes. Downloads nothing until approved.
discover maker domains date pages="120":
    @just _post "/maker?id=$1&domains=$2&date=$3&pages=$4"

# Read a maker's discovery plan before approving it.
plan maker date:
    @just _get "/archive?prefix=documents/$1/$2/plan.json"

# Let the download start, as whoever `just login` signed in. Silence is a refusal, so this is the only way it runs.
approve maker date limit="40":
    #!/usr/bin/env bash
    set -euo pipefail
    approval_json=$(node -e 'const limit=Number(process.argv[1]); if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid download limit"); console.log(JSON.stringify({approved:true,limit}))' "$3")
    just _post_json "/approve?maker=$1&date=$2" "$approval_json"

# Convert a maker's approved documents; each one enqueues its own reading.
convert maker date:
    @just _post "/convert?id=$1&date=$2"

# Draw and read the pages of a maker's documents that converted to no text. The supervisor does this daily.
vision maker date:
    @just _post "/vision?id=$1&date=$2"

# Forget what the prompted readers said about a maker's approved documents, so the next `just convert` reads them again with the prompts as they are now. Counts only, unless dry is false; the convert that follows spends reader credits.
forget maker dry="true":
    #!/usr/bin/env bash
    set -euo pipefail
    from=0
    run=""
    while :; do
      answer=$(just _post "/forget?id=$1&dry=$2&from=$from&run=$run")
      echo "$answer"
      run=$(node -e 'console.log(JSON.parse(process.argv[1]).run)' "$answer")
      from=$(node -e 'const a = JSON.parse(process.argv[1]); console.log(a.next ?? "")' "$answer")
      [ -n "$from" ] || break
    done

# Build the site the Worker serves.
site:
    cd apps/site && pnpm build

# ---- logos ----

# Find a logo for every maker: its own site first, a shop's brand page where that fails.
logos *args:
    node tools/logos/gather.ts "$@"

# Put the gathered logos in the archive, where the Worker serves them without a token.
logos-upload *args:
    node tools/logos/upload.ts "$@"

# Publish the built tables to data.origin89.com. Only publish.yml can; --dry-run lists what would go up.
publish *args:
    node tools/dataset/publish.ts "$@"

# ---- feeds ----

# Check the pinned SAM libraries against upstream. Reports a change, never takes it.
sync-sam *args:
    node tools/feeds/sync-sam.ts "$@"

# Take the change, after reading what it moved.
sync-sam-accept:
    node tools/feeds/sync-sam.ts --accept

# ---- the gate before a commit ----

# All required offline checks.
check:
    pnpm check

fmt:
    pnpm format

fmt-check:
    pnpm format:check

lint:
    pnpm lint

typecheck:
    pnpm typecheck

test:
    pnpm test
    pnpm test:apps

validate:
    pnpm validate

build-twice:
    pnpm build:repeat

build:
    pnpm build

# ---- deployment ----

# Deploy from CI. A deploy arms a weekly crawl, so it is a decision, not a merge.
deploy: site
    gh workflow run "Deploy the spider" --repo origin89hq/offgrid-equipment --ref main

_url:
    @echo "${OFFGRID_BASE_URL:-http://localhost:8790}"

_token:
    @node tools/credential.ts "$(just _url)"

_get path:
    @curl --connect-timeout 10 --max-time 30 -fsS "$(just _url)$1" -H "authorization: Bearer $(just _token)"

_post path:
    @curl --connect-timeout 10 --max-time 30 -fsS -X POST "$(just _url)$1" -H "authorization: Bearer $(just _token)"

_post_json path body:
    @curl --connect-timeout 10 --max-time 30 -fsS -X POST "$(just _url)$1" -H "authorization: Bearer $(just _token)" -H 'content-type: application/json' --data "$2"

# Read a maker's own specification tables. A parser, not a model: nothing to approve, nothing spent.
spec-pages maker date:
    @just _post "/spec-pages?id=$1&date=$2"

# What specification pages a maker's own site turned out to publish, from the last discovery.
spec-pages-found maker date *args:
    node tools/feeds/adopt-spec-pages.ts "$@"

# Write the manufacturer list the Worker bundles, with what the records cite on its hosts. Run after changing a maker's domains or a source's url.
export-makers:
    node tools/feeds/export-makers.ts

# What a maker prints that no mapping rule reads yet, grouped by the key each name most likely belongs to. Start a maker's mapping file from this.
mapping-draft maker:
    node tools/mappings/draft.ts {{maker}}

# Rewrite the coverage snapshot the tests compare the mappings against. Run after changing a mapping, a record or the builder, and commit the diff with the change.
coverage-snapshot:
    node tools/mappings/coverage-snapshot.ts

# Discovery over every maker at once. Reads only what they publish; downloads still wait for you.
discover-all date pages="150":
    @just _post "/discover-all?date=$1&pages=$2"

# Sign in with GitHub for the spider's control routes. Only members of origin89hq/working-group get in.
login:
    node tools/login.ts

# What this knows, what the spider is waiting on, and what is waiting on you.
status:
    node tools/status.ts

# Put a release into the store behind the EquipmentApi, or back after a schema change. Reads R2, writes D1, spends nothing.
load release:
    @just _post "/load?release=$1"

# Move everything whose precondition is met. Never approves; that stays with you.
supervise date="":
    @just _post "/supervise?date=$1"

# The same on the deployed spider, through its workflow, so the token stays in GitHub. `true` also offers every converted maker to the page reader.
supervise-prod offer_all="false":
    gh workflow run "Supervise the spider" --repo origin89hq/offgrid-equipment --ref main -f offer_all="$1"


# Refresh the shared skills once at the start of a task.
skills-sync:
    python3 .origin89/sync-engineering.py

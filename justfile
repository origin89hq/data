# Every command this repository needs, and what each one is for.
# `just` on its own lists them.

set positional-arguments

# Where the spider lives. Unset, everything talks to `just dev` on this machine.
export OFFGRID_BASE_URL := env_var_or_default("OFFGRID_BASE_URL", "")
export OFFGRID_CONTROL_TOKEN := env_var_or_default("OFFGRID_CONTROL_TOKEN", "")

_default:
    @just --list --unsorted

# ---- the gate: what needs a person ----

# What is waiting at the gate, most in-scope listings first.
gate *args:
    node tools/gate/decide.ts list {{args}}

# One brand with all its evidence.
show brand:
    node tools/gate/decide.ts show {{brand}}

# This brand is made by that company, and why. The basis is not optional.
is brand maker *basis:
    node tools/gate/decide.ts is {{brand}} {{maker}} {{basis}}

# Not equipment this database covers, and why.
skip brand *reason:
    node tools/gate/decide.ts skip {{brand}} {{reason}}

# Add a manufacturer. Its domains are what hop two may crawl.
maker id name website="" *domains:
    node tools/gate/decide.ts maker {{id}} {{name}} {{website}} {{domains}}

# ---- records from crawls ----

# Fold crawls into the brand queue. Decides nothing.
queue date +sellers:
    node tools/gate/queue.ts {{date}} {{sellers}}

# Derive model records from crawls whose brands the gate has answered.
models date +sellers:
    node tools/gate/models.ts {{date}} {{sellers}}

# Fold the classifier's answers onto models that have no kind.
kinds *args:
    node tools/gate/pull-kinds.ts {{args}}

# Write spec records from a maker's readings.
specs maker date *args:
    node tools/gate/pull-specs.ts {{maker}} {{date}} {{args}}

# ---- the spider ----

# Run the Worker locally, with a local R2 and the AI binding proxied to Cloudflare.
dev:
    cd scraper && pnpm exec wrangler dev --port 8790

# Crawl one seller.
crawl seller date="" *args:
    @just _post "/run?seller={{seller}}&date={{date}}{{args}}"

# Classify a finished crawl. Listings already answered cost nothing.
classify seller date:
    @just _post "/classify?seller={{seller}}&date={{date}}"

# Find what documents a maker publishes. Downloads nothing until approved.
discover maker domains date pages="120":
    @just _post "/maker?id={{maker}}&domains={{domains}}&date={{date}}&pages={{pages}}"

# Read a maker's discovery plan before approving it.
plan maker date:
    @just _get "/archive?prefix=documents/{{maker}}/{{date}}/plan.json"

# Let the download start. Silence is a refusal, so this is the only way it runs.
approve maker date approver limit="40":
    @just _post_json "/approve?id=maker-{{maker}}-{{date}}" '{"approved":true,"approvedBy":"{{approver}}","limit":{{limit}}}'

# Convert a maker's approved documents; each one enqueues its own reading.
convert maker date:
    @just _post "/convert?id={{maker}}&date={{date}}"

# ---- feeds ----

# Check the pinned SAM libraries against upstream. Reports a change, never takes it.
sync-sam *args:
    node tools/feeds/sync-sam.ts {{args}}

# Take the change, after reading what it moved.
sync-sam-accept:
    node tools/feeds/sync-sam.ts --accept

# ---- the gate before a commit ----

# Everything CI runs.
check: test validate build-twice

test:
    node --test test/*.test.ts
    cd scraper && node --test test/*.test.ts
    cd scraper && pnpm exec wrangler types && pnpm exec tsc --noEmit

# Every record against its schema, then every reference between them.
validate:
    node src/validate.ts

# The artefacts, and proof two builds of the same records are the same bytes.
build-twice:
    node src/build.ts
    sha256sum dist/* | sort > /tmp/offgrid-build-1
    node src/build.ts > /dev/null
    sha256sum dist/* | sort > /tmp/offgrid-build-2
    diff /tmp/offgrid-build-1 /tmp/offgrid-build-2

build:
    node src/build.ts

# ---- deployment ----

# Deploy from CI. A deploy arms a weekly crawl, so it is a decision, not a merge.
deploy:
    gh workflow run "Deploy the spider" --repo origin89hq/offgrid-equipment --ref main

_url:
    @echo "${OFFGRID_BASE_URL:-http://localhost:8790}"

_token:
    @if [ -n "$OFFGRID_CONTROL_TOKEN" ]; then echo "$OFFGRID_CONTROL_TOKEN"; else sed -n 's/^CONTROL_TOKEN=//p' scraper/.dev.vars; fi

_get path:
    @curl -fsS "$(just _url){{path}}" -H "authorization: Bearer $(just _token)"

_post path:
    @curl -fsS -X POST "$(just _url){{path}}" -H "authorization: Bearer $(just _token)"

_post_json path body:
    @curl -fsS -X POST "$(just _url){{path}}" -H "authorization: Bearer $(just _token)" -H 'content-type: application/json' -d '{{body}}'

# Read a maker's own specification tables. A parser, not a model: nothing to approve, nothing spent.
spec-pages maker date:
    @just _post "/spec-pages?id={{maker}}&date={{date}}"

# What specification pages a maker's own site turned out to publish, from the last discovery.
spec-pages-found maker date *args:
    node tools/feeds/adopt-spec-pages.ts {{maker}} {{date}} {{args}}

# Write the manufacturer list the Worker bundles. Run after changing a maker's domains.
export-makers:
    node tools/feeds/export-makers.ts

# Discovery over every maker at once. Reads only what they publish; downloads still wait for you.
discover-all date pages="150":
    @just _post "/discover-all?date={{date}}&pages={{pages}}"

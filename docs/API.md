# The EquipmentApi

A read-only interface over one release of the dataset, served by the Worker (`offgrid-equipment-worker`,
the name in `apps/worker/wrangler.jsonc`) as a named entrypoint and reached over a Cloudflare service binding. There is no public HTTP route: a
consumer is another Worker in the same account. The contract, its types and the model key
rule live in `packages/api`; the implementation is `apps/worker/src/equipment-api.ts`.

## Binding it

```jsonc
// the consumer's wrangler.jsonc
"services": [
  { "binding": "EQUIPMENT", "service": "offgrid-equipment-worker", "entrypoint": "EquipmentApi" }
]
```

```ts
import type { EquipmentApi } from "@origin89/equipment-api";

const api = env.EQUIPMENT as unknown as EquipmentApi;
const release = await api.release();          // the active release
const pinned = await api.release(releaseId);  // one an evaluation fixture names
```

Pin `@origin89/equipment-api` from this repository's git history rather than copying its
types, so a change to the contract is a version change on the consumer's side. The package is
raw TypeScript with no build step; a consumer bundled by wrangler reads it as is.

## One release for one turn

`release()` returns a handle bound to one release. Every method on it reads that release and
no other, and every claim, link and source it returns comes from it. The handle has methods
only: over a service binding a property of an RPC target arrives as a promise, so the release's
id and contract version come from `info()`, which a consumer checks once at the start of a turn.
The version is the release's own, what its tables hold: 2 carries link evidence and a dialect's
`readings` and `codes`, and a release published before those tables existed answers 1, so its
empty lists are the absence of that data and a consumer needing 2 refuses it. Take one handle at the
start of a turn and use it for every lookup in that turn; a release that lands mid-turn changes
nothing the handle answers. `release(id)` gives a retained release by id, which is how a pinned
evaluation stays reproducible while releases move on. A release still loading, one whose load
failed, or one let go by retention is refused with `NoSuchRelease`.

## Methods

| Method | Answers |
|---|---|
| `info()` | the release id, its content hash, when it was published, the contract the release answers to, and the row counts loaded |
| `resolve({ brand?, model, kind? })` | `exact` with one model, `ambiguous` with the candidates that share the key, or `none` with near neighbours a consumer may show and must never pick |
| `resolve({ label })` | the same for a name read off a device or a photo, with the maker printed before or after the name, abbreviated, or left off; a label that prints another maker before a name reaches nothing |
| `search({ brand?, prefix?, kind?, limit, cursor? })` | a page of models ordered by name, with a cursor while there is more; a cursor is opaque, short whatever the names are, and only one this search gave out is taken |
| `bundle({ models, properties?, claims?, protocol? })` | up to eight models with their aliases, their printed figures, their protocol links with how each was made, the dialect's confidence, gotchas, citations, structured readings and code tables where somebody has done that work, and exactly the sources those rows cite |
| `sources(ids)` | source records by id |
| `properties()` | the property registry, empty until #82 defines it; `bundle` reports every property asked for as a gap with the reason `no-registry` |

Names are matched by the one key rule in `packages/api/src/keys.ts`: Unicode NFKC, lower case,
spaces and dashes removed, the maker's or brand's part followed by the model's, with the maker's
own name taken off the front of the model name. A key that reaches two models is ambiguous and
stays so; the interface never breaks the tie.

## Limits

A prefix with no letter or digit in it, and a brand more than 45 makers answer to, are refused
with the reason rather than answered with a page of everything or of some.

Every list is cut at a limit the contract states in `LIMITS`, and a cut is said out loud:
`truncated` on a resolution or a page, and the list of cut lists on a bundle (`claims`,
`protocol`, `sources`, `readings`, `codes`). Nothing is quietly shorter than the release holds.
A reading with `conditional` set is one only some models of the dialect give, and the text
says what decides it: check the model before polling for it, and never read an absent field
as zero.

## What a consumer must not do

A `confidence` of `unverified` on a dialect means the link must not be presented as supported.
A link's own `confidence` is what its own sources support for that model: a `catalogue-name`
link is always `unverified`, whatever the dialect is rated, since the catalogue naming a
model is a claim and not evidence.
`reviewedBy` is the only field that says a person checked a figure; `extractedBy` names what
read it. A near neighbour from `resolve` is for showing, never for picking.

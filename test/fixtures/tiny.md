# Tiny family

Written for the tests.

**2 dialects** — unverified 1 · vendor-doc 1

**Possible duplicates, not merged.** Parallel research agents cannot see
each other's output, so one device can arrive under two ids. These were
left as found — merging them without re-reading the sources would destroy
evidence to tidy a list:

- `acme-one`

---

## Dialect: `acme-one`

**See also** `acme-two` — one device may
have arrived under more than one id, because parallel research agents
cannot see each other's output. Left unmerged: collapsing them without
re-reading the sources would destroy evidence to tidy a list.

**Driver** ✅ `cabin-acme`
**Confidence** `vendor-doc` · refuter checked
**Source** https://example.com/acme.pdf — the manual
**Source** docs/acme-notes.md — bench notes
**Transport** RS-485 · 9600 8N1
**Blocks** 0x0000 status

`reports` battery-voltage, battery-current
`accepts` set-switch

| Model | Rating | Notes |
|---|---|---|
| One-100 | 100 A | Installed here. |
| One-200 |  |  |

**Shared-map evidence** Same document names both.

- The port is not isolated.
- Reads zero, not an exception, on a bad address.

**Reports with no `MetricKind`:** fault code (0x0001)

---

## Dialect: `acme-two`

**Driver** 💡 none
**Confidence** `unverified` · **not checked** — no refuter ran
**Source** Acme, product page only

| Model |
|---|
| Two |

**REFUTED on review.** The page names no protocol.

Its shared-register-map claim was dropped with it: these models are
listed together because one agent proposed it, not because a source
shows matching addresses.

- Nothing to build on.

---

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
- Absent beats plausible. A baud rate the document does not state stays out of
  the record; write the gap in `gotchas`.
- Run `pnpm validate && pnpm test` before opening the pull request.

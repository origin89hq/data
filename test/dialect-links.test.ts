import assert from "node:assert/strict";
import { test } from "node:test";
import type { DialectLink } from "@origin89/equipment-schema/model";
import { catalogueLink, mergeLinks, sameLinks } from "../src/dialect-links.ts";

const link = (
  kind: DialectLink["evidence"]["kind"],
  citation: string,
  confidence: DialectLink["confidence"] = "vendor-doc",
): DialectLink => ({
  dialect: "d",
  evidence:
    kind === "catalogue-name"
      ? { kind, sources: [] }
      : { kind, sources: [{ source: "s", citation }] },
  confidence: kind === "catalogue-name" ? "unverified" : confidence,
});

test("merging links keeps the stronger evidence whichever side it came from, and refreshes a catalogue claim", () => {
  const catalogue = link("catalogue-name", "old");
  const register = link("register-match", "p. 4");
  assert.deepEqual(
    mergeLinks([catalogue], [register]),
    [register],
    "a register match on the dropped side survives",
  );
  assert.deepEqual(
    mergeLinks([register], [catalogue]),
    [register],
    "and is not replaced by a claim",
  );
  assert.deepEqual(
    mergeLinks([{ ...catalogue, firmware: { min: "1" } }], [catalogue]),
    [catalogue],
    "a later catalogue claim is the fresher one",
  );
  const vendor = link("vendor-doc", "manual");
  assert.deepEqual(
    mergeLinks([vendor], [link("vendor-doc", "other manual")]),
    [vendor],
    "between two of a person's kind, the first stays",
  );
  assert.deepEqual(
    mergeLinks([{ ...register, dialect: "b" }], [{ ...catalogue, dialect: "a" }]).map(
      (l) => l.dialect,
    ),
    ["a", "b"],
    "sorted by dialect",
  );
  assert.equal(sameLinks([register], [register]), true);
  assert.equal(
    sameLinks([register], [catalogue]),
    false,
    "the same dialect under other evidence is a change to write",
  );
  assert.equal(
    sameLinks([catalogue], [{ ...catalogue, firmware: { min: "1" } }]),
    false,
    "a claim whose fields moved is a change to write",
  );
  assert.equal(sameLinks([register], []), false);
  assert.deepEqual(
    catalogueLink({ id: "x" }),
    { dialect: "x", evidence: { kind: "catalogue-name", sources: [] }, confidence: "unverified" },
    "a catalogue claim is unverified however the dialect is rated",
  );
});

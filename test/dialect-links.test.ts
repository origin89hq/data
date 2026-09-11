import assert from "node:assert/strict";
import { test } from "node:test";
import type { DialectLink } from "@origin89/equipment-schema/model";
import { catalogueLink, mergeLinks, sameDialects } from "../src/dialect-links.ts";

const link = (kind: DialectLink["evidence"]["kind"], citation: string): DialectLink => ({
  dialect: "d",
  evidence: { kind, sources: [{ source: "s", citation }] },
  confidence: "vendor-doc",
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
    mergeLinks([catalogue], [link("catalogue-name", "new")]),
    [link("catalogue-name", "new")],
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
  assert.equal(sameDialects([register], [catalogue]), true);
  assert.equal(sameDialects([register], []), false);
  assert.equal(
    catalogueLink({ id: "x", sources: [{ source: "s", citation: "c" }], confidence: "unverified" })
      .evidence.kind,
    "catalogue-name",
  );
});

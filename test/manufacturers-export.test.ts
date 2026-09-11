import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostAllowed } from "@origin89/equipment-schema/documents";
import { citedFor } from "../src/cited.ts";
import { loadRecords } from "../src/records.ts";

const exported = JSON.parse(
  readFileSync(new URL("../apps/worker/manufacturers.json", import.meta.url), "utf8"),
) as { id: string; domains: string[]; cited?: { documents: string[]; pages: string[] } }[];
const records = loadRecords();

test("the bundled list matches the records it was generated from", () => {
  const expected = records.manufacturers
    .filter((m) => m.domains.length > 0)
    .map((m) => {
      const cited = citedFor(m, records.sources);
      return {
        id: m.id,
        domains: m.domains,
        ...(cited.documents.length || cited.pages.length ? { cited } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    exported,
    expected,
    "run `just export-makers` after changing a manufacturer's domains or a source's url",
  );
});

test("what the records cite is bundled by maker, and EPEVER's controller manual is among it", () => {
  const epever = exported.find((m) => m.id === "epever");
  assert.ok(epever?.cited, "EPEVER has cited sources");
  assert.ok(
    epever.cited.documents.includes(
      "https://www.epever.com/wp-content/uploads/2024/01/XTRA-N-G3-BLE-Manual-EN-V1.8.pdf",
    ),
    "the XTRA-N G3 manual a dialect record cites is offered to discovery",
  );
  for (const m of exported)
    for (const url of [...(m.cited?.documents ?? []), ...(m.cited?.pages ?? [])])
      assert.ok(
        hostAllowed(new URL(url).hostname, m.domains),
        `${m.id} is bundled with ${url}, which is not on its hosts`,
      );
});

test("every exported maker claims at least one domain, since discovery has nothing to look at otherwise", () => {
  for (const m of exported) assert.ok(m.domains.length > 0, `${m.id} has no domain`);
});

test("a maker with no domain is left out rather than shipped as an instance that must fail", () => {
  const without = records.manufacturers.filter((m) => m.domains.length === 0).map((m) => m.id);
  for (const id of without)
    assert.equal(
      exported.some((m) => m.id === id),
      false,
      `${id} claims no domain and should not be shipped`,
    );
});

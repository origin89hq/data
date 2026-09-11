import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostAllowed } from "@origin89/equipment-schema/documents";
import { Manufacturer } from "@origin89/equipment-schema/manufacturer";
import { citedFor, sourceIdsCitedBy } from "../src/cited.ts";
import { loadRecords } from "../src/records.ts";

const exported = JSON.parse(
  readFileSync(new URL("../apps/worker/manufacturers.json", import.meta.url), "utf8"),
) as {
  id: string;
  domains: string[];
  documentHosts?: string[];
  cited?: { documents: string[]; pages: string[] };
}[];
const records = loadRecords();

test("the bundled list matches the records it was generated from", () => {
  const expected = records.manufacturers
    .filter((m) => m.domains.length > 0)
    .map((m) => {
      const cited = citedFor(m, records.sources, sourceIdsCitedBy(m.id, records));
      return {
        id: m.id,
        domains: m.domains,
        ...(m.documentHosts?.length ? { documentHosts: m.documentHosts } : {}),
        ...(cited.documents.length || cited.pages.length ? { cited } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    exported,
    expected,
    "run `just export-makers` after changing a manufacturer's domains, document hosts or a source's url",
  );
});

test("a document host is a bare host name, the same shape as a domain, and never a page to read", () => {
  const maker = { id: "eco-worthy", name: "ECO-WORTHY", domains: ["eco-worthy.com"] };
  assert.deepEqual(
    Manufacturer.parse({ ...maker, documentHosts: ["cdn.shopify.com"] }).documentHosts,
    ["cdn.shopify.com"],
  );
  assert.equal(Manufacturer.parse(maker).documentHosts, undefined);
  // A host on a record with no domain would never be read from, so it is refused up front.
  assert.throws(() =>
    Manufacturer.parse({ id: "x", name: "X", documentHosts: ["cdn.shopify.com"] }),
  );
  assert.throws(() =>
    Manufacturer.parse({ id: "x", name: "X", domains: [], documentHosts: ["cdn.shopify.com"] }),
  );
  assert.throws(() =>
    Manufacturer.parse({ ...maker, documentHosts: ["https://cdn.shopify.com/"] }),
  );
  assert.throws(() => Manufacturer.parse({ ...maker, documentHosts: ["cdn.shopify.com/s/files"] }));
  // A typo in a label would never match a real host and would report the documents as foreign.
  const tooLongLabel = `${"a".repeat(64)}.shopify.com`;
  const tooLongName = `${Array.from({ length: 5 }, () => "b".repeat(50)).join(".")}.com`;
  for (const typo of [
    ".cdn.shopify.com",
    "cdn..shopify.com",
    "cdn-.shopify.com",
    "-cdn.shopify.com",
    tooLongLabel,
    tooLongName,
  ])
    assert.throws(() => Manufacturer.parse({ ...maker, documentHosts: [typo] }), typo);
  assert.deepEqual(
    Manufacturer.parse({ ...maker, documentHosts: ["d1abc.cloudfront.net", "a-b.c.example"] })
      .documentHosts,
    ["d1abc.cloudfront.net", "a-b.c.example"],
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

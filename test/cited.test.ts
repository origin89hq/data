import assert from "node:assert/strict";
import { test } from "node:test";
import { citedFor, sourceIdsCitedBy } from "../src/cited.ts";

const maker = { domains: ["epever.com", "epsolarpv.com"] };

test("a source on the maker's hosts is offered as a document or read as a page, by what it is", () => {
  const cited = citedFor(maker, [
    {
      id: "a",
      url: "https://www.epever.com/wp-content/uploads/2024/01/XTRA-N-G3-BLE-Manual-EN-V1.8.pdf",
    },
    { id: "b", url: "https://www.epever.com/product/xtra-n-g3-mppt-charge-controller/" },
    { id: "c", url: "https://epsolarpv.com/download/duc-series-resources/#top" },
    {
      id: "d",
      url: "https://www.epever.com/wp-content/uploads/2024/01/EPEVER-DataSheet-XTRA-N-G3-Series.pdf",
    },
  ]);
  assert.deepEqual(cited, {
    documents: [
      "https://www.epever.com/wp-content/uploads/2024/01/EPEVER-DataSheet-XTRA-N-G3-Series.pdf",
      "https://www.epever.com/wp-content/uploads/2024/01/XTRA-N-G3-BLE-Manual-EN-V1.8.pdf",
    ],
    pages: [
      "https://epsolarpv.com/download/duc-series-resources/",
      "https://www.epever.com/product/xtra-n-g3-mppt-charge-controller/",
    ],
  });
});

test("another maker's host, a source held only by path, and a source cited twice give nothing extra", () => {
  const cited = citedFor(maker, [
    { id: "a", url: "https://www.victronenergy.com/upload/documents/manual.pdf" },
    { id: "b", path: "docs/epever-xtra-n-g3-manual-v1.8.pdf" },
    { id: "c", url: "https://www.epever.com/a.pdf" },
    { id: "d", url: "https://www.epever.com/a.pdf" },
    { id: "e", url: "ftp://www.epever.com/b.pdf" },
    { id: "f", url: "https://notepever.com/c.pdf" },
  ]);
  assert.deepEqual(cited, { documents: ["https://www.epever.com/a.pdf"], pages: [] });
});

test("a maker with no domain is cited nothing, since it has no host to be cited on", () => {
  assert.deepEqual(citedFor({ domains: [] }, [{ id: "a", url: "https://www.epever.com/a.pdf" }]), {
    documents: [],
    pages: [],
  });
});

test("a source is a maker's only when one of its own records cites it, not because its host does", () => {
  const records = {
    manufacturers: [
      { id: "epever", name: "EPEVER", domains: ["epever.com"], sources: ["epever-home"] },
      { id: "the-cabin-depot", name: "The Cabin Depot", domains: ["thecabindepot.ca"] },
    ],
    dialects: [
      {
        id: "epever-it-nc-g3",
        manufacturer: "epever",
        family: "modbus-rs485",
        confidence: "unverified",
        sources: [{ source: "cabin-depot-itracer-page", citation: "listing" }],
        models: [],
      },
    ],
    models: [
      {
        id: "epever-x",
        manufacturer: "epever",
        name: "X",
        aliases: [],
        // A link's own evidence is the maker's too: the document that showed the registers match.
        dialects: [
          {
            dialect: "epever-it-nc-g3",
            evidence: {
              kind: "register-match",
              sources: [{ source: "epever-x-manual", citation: "p. 12" }],
            },
            confidence: "vendor-doc",
          },
        ],
      },
    ],
    specs: [{ id: "s1", model: "epever-x", name: "n", value: "1", source: "epever-datasheet" }],
  };
  const ids = sourceIdsCitedBy("epever", records as never);
  assert.deepEqual([...ids].sort(), [
    "cabin-depot-itracer-page",
    "epever-datasheet",
    "epever-home",
    "epever-x-manual",
  ]);
  assert.deepEqual([...sourceIdsCitedBy("the-cabin-depot", records as never)], []);
  const sources = [
    { id: "cabin-depot-itracer-page", url: "https://thecabindepot.ca/products/epever-itracer" },
    { id: "cabin-depot-own", url: "https://thecabindepot.ca/pages/about" },
  ];
  // The retailer's own crawl gets nothing from a page only EPEVER's dialect cites.
  assert.deepEqual(
    citedFor(
      { domains: ["thecabindepot.ca"] },
      sources,
      sourceIdsCitedBy("the-cabin-depot", records as never),
    ),
    { documents: [], pages: [] },
  );
  // And EPEVER does not get it either: it is not on a host EPEVER's crawl may reach.
  assert.deepEqual(citedFor({ domains: ["epever.com"] }, sources, ids), {
    documents: [],
    pages: [],
  });
  assert.deepEqual(
    citedFor({ domains: ["thecabindepot.ca"] }, sources).pages.length,
    2,
    "without the maker's citations, host alone still decides",
  );
});

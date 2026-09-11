import assert from "node:assert/strict";
import { test } from "node:test";
import { citedFor } from "../src/cited.ts";

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

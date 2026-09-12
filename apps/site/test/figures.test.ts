import assert from "node:assert/strict";
import { test } from "node:test";
import { documentLabel, figuresQuery, provenanceLabel } from "../src/figures.ts";

test("a figure names its document by title, else by its site, and the page beside it", () => {
  assert.equal(
    provenanceLabel({
      document: "Radian GS4048A datasheet",
      document_url: "https://x/a.pdf",
      page: 3,
    }),
    "Radian GS4048A datasheet · page 3",
  );
  assert.equal(
    provenanceLabel({
      document: null,
      document_url: "https://www.outbackpower.com/docs/gs.pdf",
      page: 63,
    }),
    "outbackpower.com · page 63",
  );
  assert.equal(provenanceLabel({ document: "Manual", document_url: null, page: null }), "Manual");
  assert.equal(provenanceLabel({ document: null, document_url: null, page: 3 }), "page 3");
  assert.equal(provenanceLabel({ document: null, document_url: null, page: null }), undefined);
  assert.equal(documentLabel({ document: "  ", document_url: "not a url" }), "not a url");
});

test("the figures query joins each figure to its source and quotes the model id", () => {
  const sql = figuresQuery("acme-o'neil-1");
  assert.match(sql, /LEFT JOIN sources src ON src\.id = s\.source_id/);
  assert.match(sql, /src\.title AS document, src\.url AS document_url/);
  assert.match(sql, /WHERE s\.model_id = 'acme-o''neil-1'/);
  assert.match(sql, /tier <> 'feed'/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { documentLabel, documentLabels, figuresQuery, provenanceLabel } from "../src/figures.ts";

test("a figure names its document by title, else by its file, else by its site, and the page beside it", () => {
  assert.equal(
    provenanceLabel({
      document: "Radian GS4048A datasheet",
      document_url: "https://x/a.pdf",
      page: 3,
    }),
    "Radian GS4048A datasheet · page 3",
  );
  // Two files on one site are two documents; the site alone would call them the same.
  assert.equal(
    provenanceLabel({
      document: null,
      document_url: "https://old.outbackpower.com/downloads/GS4048A_Datasheet.pdf",
      page: 3,
    }),
    "GS4048A_Datasheet · page 3",
  );
  assert.equal(
    documentLabel({
      document: null,
      document_url: "https://old.outbackpower.com/downloads/GS4048A%20Operator%27s%20Manual.PDF",
    }),
    "GS4048A Operator's Manual",
  );
  assert.equal(
    documentLabel({ document: null, document_url: "https://www.outbackpower.com/" }),
    "outbackpower.com",
  );
  assert.equal(
    documentLabel({ document: null, document_url: "https://no.co/downloads/sell-sheet-gx3" }),
    "sell-sheet-gx3",
  );
  assert.equal(provenanceLabel({ document: "Manual", document_url: null, page: null }), "Manual");
  assert.equal(provenanceLabel({ document: null, document_url: null, page: 3 }), "page 3");
  assert.equal(provenanceLabel({ document: null, document_url: null, page: null }), undefined);
  assert.equal(documentLabel({ document: "  ", document_url: "not a url" }), "not a url");
});

test("two documents published under one file name are told apart by the directory above it", () => {
  const gx =
    "https://www.victronenergy.com/upload/documents/MultiPlus-II_GX/2983-MultiPlus-II_GX-pdf-en.pdf";
  const big =
    "https://www.victronenergy.com/upload/documents/MultiPlus-II_4k5_6k5_GX/2983-MultiPlus-II_GX-pdf-en.pdf";
  const other = "https://www.victronenergy.com/upload/documents/Manual.pdf";
  const rows = [
    { document: null, document_url: gx, page: 2 },
    { document: null, document_url: big, page: 2 },
    { document: null, document_url: gx, page: 5 },
    { document: null, document_url: other, page: 1 },
  ];
  const labels = documentLabels(rows);
  assert.equal(labels.get(gx), "MultiPlus-II_GX/2983-MultiPlus-II_GX-pdf-en");
  assert.equal(labels.get(big), "MultiPlus-II_4k5_6k5_GX/2983-MultiPlus-II_GX-pdf-en");
  // A file name no other document shares keeps its short label.
  assert.equal(labels.get(other), "Manual");
  assert.equal(
    provenanceLabel(rows[0] ?? {}, labels),
    "MultiPlus-II_GX/2983-MultiPlus-II_GX-pdf-en · page 2",
  );
  // Same directory name too: the whole path is what is left to tell them apart.
  const deep = documentLabels([
    { document: null, document_url: "https://x.example/a/docs/sheet.pdf" },
    { document: null, document_url: "https://x.example/b/docs/sheet.pdf" },
  ]);
  assert.equal(deep.get("https://x.example/a/docs/sheet.pdf"), "a/docs/sheet");
  assert.equal(deep.get("https://x.example/b/docs/sheet.pdf"), "b/docs/sheet");
  // A title is a title; two documents with one title are the record's problem, not the label's.
  assert.equal(
    documentLabels([{ document: "Datasheet", document_url: "https://x.example/d.pdf" }]).get(
      "https://x.example/d.pdf",
    ),
    "Datasheet",
  );
  assert.equal(
    provenanceLabel({ document: null, document_url: gx, page: null }),
    "2983-MultiPlus-II_GX-pdf-en",
  );
});

test("a document the archive holds without an address is named by its file there, and one with neither by its id", () => {
  const filed = {
    document: null,
    document_url: null,
    document_path: "docs/victron-bms-overview-datasheet.pdf",
    document_id: "victron-bms-overview-datasheet",
    page: 4,
  };
  assert.equal(provenanceLabel(filed), "victron-bms-overview-datasheet · page 4");
  assert.equal(
    documentLabel({
      document: null,
      document_url: null,
      document_path: null,
      document_id: "midnite-classic-manual",
    }),
    "midnite-classic-manual",
  );
  // Two archived files with one name are told apart the way two addresses are.
  const labels = documentLabels([
    { document: null, document_url: null, document_path: "docs/a/sheet.pdf", document_id: "s1" },
    { document: null, document_url: null, document_path: "docs/b/sheet.pdf", document_id: "s2" },
    filed,
  ]);
  assert.equal(labels.get("s1"), "a/sheet");
  assert.equal(labels.get("s2"), "b/sheet");
  assert.equal(labels.get("victron-bms-overview-datasheet"), "victron-bms-overview-datasheet");
});

test("the figures query joins each figure to its source and quotes the model id", () => {
  const sql = figuresQuery("acme-o'neil-1");
  assert.match(sql, /LEFT JOIN sources src ON src\.id = s\.source_id/);
  assert.match(sql, /src\.title AS document, src\.url AS document_url, src\.path AS document_path/);
  assert.match(sql, /src\.id AS document_id/);
  assert.match(sql, /WHERE s\.model_id = 'acme-o''neil-1'/);
  assert.match(sql, /tier <> 'feed'/);
});

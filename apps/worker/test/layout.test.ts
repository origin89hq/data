import assert from "node:assert/strict";
import { test } from "node:test";
import { columnsOf, gridOf, markdownOf, rowsOf } from "../src/layout.ts";
import { charsOn } from "../src/render.ts";
import { BLACK_BOX, type Placed, pdfium, tinyPdf, writtenPdf } from "./pdf.ts";

/** A datasheet's shape: a name at the left and a value under each model's heading. */
const SHEET: Placed[] = [
  { text: "Specifications", x: 20, y: 180, size: 12 },
  { text: "Model", x: 20, y: 160 },
  { text: "S-550", x: 120, y: 160 },
  { text: "S-600", x: 200, y: 160 },
  { text: "Weight", x: 20, y: 140 },
  { text: "42 kg", x: 120, y: 140 },
  { text: "51 kg", x: 200, y: 140 },
  { text: "Rated capacity", x: 20, y: 120 },
  { text: "100 Ah", x: 120, y: 120 },
  { text: "120 Ah", x: 200, y: 120 },
  { text: "Working current", x: 20, y: 100 },
  { text: "0.5C", x: 120, y: 100 },
  { text: "0.5C", x: 200, y: 100 },
];

const charsOfPage = async (page: Placed[]) => charsOn(await pdfium(), writtenPdf([page]), 1);

test("a value sits under the model it belongs to, whatever the page says beside it", async () => {
  const rows = rowsOf(await charsOfPage(SHEET));
  const columns = columnsOf(rows);
  assert.equal(columns.length, 3, "a name column and one for each model");
  assert.deepEqual(gridOf(rows, columns), [
    ["Specifications", "", ""],
    ["Model", "S-550", "S-600"],
    ["Weight", "42 kg", "51 kg"],
    ["Rated capacity", "100 Ah", "120 Ah"],
    ["Working current", "0.5C", "0.5C"],
  ]);
});

test("a table is written as a table, and the heading above it as a line of its own", async () => {
  const markdown = markdownOf(await charsOfPage(SHEET));
  assert.equal(
    markdown,
    [
      "Specifications",
      "|  | | |",
      "|---|---|---|",
      "| Model | S-550 | S-600 |",
      "| Weight | 42 kg | 51 kg |",
      "| Rated capacity | 100 Ah | 120 Ah |",
      "| Working current | 0.5C | 0.5C |",
    ].join("\n"),
  );
});

test("a page of prose is prose: one column is not a table with a cell a line", async () => {
  const markdown = markdownOf(
    await charsOfPage([
      { text: "Read this manual before installing the inverter.", x: 20, y: 180 },
      { text: "Keep it for future reference. The warranty does", x: 20, y: 165 },
      { text: "not cover damage from incorrect wiring.", x: 20, y: 150 },
    ]),
  );
  assert.ok(!markdown.includes("|"), markdown);
  assert.match(markdown, /^Read this manual before installing the inverter\./);
});

test("one line's indent is not a column, and a pipe inside a cell does not end it", async () => {
  const rows = rowsOf(
    await charsOfPage([
      ...SHEET,
      // One note, indented to where nothing else starts.
      { text: "Measured at 25 C", x: 160, y: 80 },
      { text: "Terminal", x: 20, y: 60 },
      { text: "M8 | M10", x: 120, y: 60 },
    ]),
  );
  const columns = columnsOf(rows);
  assert.equal(columns.length, 3, "the note's own indent is not a fourth column");
  const markdown = markdownOf(
    await charsOfPage([
      ...SHEET,
      { text: "Terminal", x: 20, y: 60 },
      { text: "M8 | M10", x: 120, y: 60 },
    ]),
  );
  assert.match(markdown, /\| Terminal \| M8 \\\| M10 \|/, markdown);
});

test("two columns no row ever fills at once are one column said twice", async () => {
  // A sheet writes a name and its unit apart — "Dimension" then "(L*W*H) ±2mm" — and the values
  // stand clear of both. Read as two columns, every row would be half empty.
  const rows = rowsOf(
    await charsOfPage([
      { text: "Model", x: 20, y: 160 },
      { text: "S-550", x: 120, y: 160 },
      { text: "S-600", x: 200, y: 160 },
      { text: "Dimension", x: 20, y: 140 },
      { text: "260*168*209", x: 120, y: 140 },
      { text: "483*170*240", x: 200, y: 140 },
      { text: "(L*W*H)", x: 60, y: 125 },
      { text: "Weight", x: 20, y: 105 },
      { text: "42 kg", x: 120, y: 105 },
      { text: "51 kg", x: 200, y: 105 },
    ]),
  );
  assert.equal(columnsOf(rows).length, 3);
});

test("a page drawn as a picture has no characters to read, and is left to the page reader", async () => {
  assert.deepEqual(charsOn(await pdfium(), tinyPdf([BLACK_BOX]), 1), []);
  assert.equal(markdownOf([]), "");
});

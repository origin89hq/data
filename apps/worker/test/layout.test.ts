import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columnsOf,
  gridOf,
  markdownOf,
  OPENING,
  rowsOf,
  sectionsOf,
  withOpenings,
} from "../src/layout.ts";
import { SYSTEM, textLayer } from "../src/reading.ts";
import {
  charsOn,
  convertPdf,
  joined,
  MOST_TEXT_PAGES,
  MOSTLY_DRAWN,
  markdownOfDocument,
  outlineOf,
  pageCount,
  picturesOn,
  rulesOn,
} from "../src/render.ts";
import { BLACK_BOX, GREY_SCAN, type Placed, pdfium, tinyPdf, writtenPdf } from "./pdf.ts";

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

test("a label printed up the side is a line of its own, not a letter in every row", async () => {
  // A Progressive Dynamics manual is typeset sideways, every character turned a quarter circle.
  // Read as though upright, its letters fell one into each row they passed: the page came out as
  // "OOCCACC/RERRTREVNERMINRTELE".
  const markdown = markdownOf(
    await charsOfPage([...SHEET, { text: "Page: 16", x: 280, y: 20, turn: 1 }]),
  );
  assert.match(markdown, /\| Weight \| 42 kg \| 51 kg \|/, markdown);
  assert.match(markdown, /^Page: 16$/m, markdown);
});

test("a page typeset sideways reads as the page it is", async () => {
  const markdown = markdownOf(
    await charsOfPage([
      { text: "Model", x: 40, y: 20, turn: 1 },
      { text: "S-550", x: 40, y: 120, turn: 1 },
      { text: "Weight", x: 60, y: 20, turn: 1 },
      { text: "42 kg", x: 60, y: 120, turn: 1 },
      { text: "Rated capacity", x: 80, y: 20, turn: 1 },
      { text: "100 Ah", x: 80, y: 120, turn: 1 },
    ]),
  );
  assert.match(markdown, /\| Weight \| 42 kg \|/, markdown);
  assert.match(markdown, /\| Rated capacity \| 100 Ah \|/, markdown);
});

test("a document reads page by page, under the headings the reader windows on", async () => {
  const pdf = writtenPdf([
    SHEET,
    [{ text: "Read this manual before installing the inverter.", x: 20, y: 180 }],
  ]);
  const markdown = markdownOfDocument(await pdfium(), pdf);
  assert.equal(pageCount(await pdfium(), pdf), 2);
  assert.deepEqual(
    markdown.split("\n").filter((line) => line.startsWith("### Page")),
    ["### Page 1", "### Page 2"],
  );
  assert.match(markdown, /### Page 1\n[\s\S]*\| Weight \| 42 kg \| 51 kg \|/);
  assert.match(markdown, /### Page 2\nRead this manual before installing the inverter\./);
});

test("a document longer than the converter writes is cut where it stops, and says so", async () => {
  const pages = Array.from({ length: 4 }, (_, i) => [{ text: `Page ${i + 1}`, x: 20, y: 180 }]);
  const converted = convertPdf(await pdfium(), writtenPdf(pages), 2);
  assert.deepEqual(
    converted.markdown.split("\n").filter((line) => line.startsWith("### Page")),
    ["### Page 1", "### Page 2"],
  );
  assert.deepEqual([converted.pages, converted.converted], [4, 2]);
});

test("a manual past eighty pages is written down to its last page, where it prints its specifications", async () => {
  // The converter stopped at page 80 and said nothing: Victron's off-grid booklet has 140 pages,
  // and its battery tables are past the eightieth.
  assert.ok(MOST_TEXT_PAGES >= 513, "the longest of wave 2's documents has 513 pages");
  const pages: Placed[][] = Array.from({ length: 85 }, (_, i) => [
    { text: `Installation, page ${i + 1}`, x: 20, y: 180 },
  ]);
  pages[84] = [
    { text: "9.1 Specifications", x: 20, y: 180 },
    { text: "Continuous power 3000 W", x: 20, y: 150 },
  ];
  const converted = convertPdf(await pdfium(), writtenPdf(pages));
  assert.deepEqual([converted.pages, converted.converted], [85, 85]);
  assert.match(converted.markdown, /### Page 85\n[\s\S]*Continuous power 3000 W/);
  assert.deepEqual(
    converted.outline.filter((heading) => heading.page === 85).map((heading) => heading.text),
    ["9.1 Specifications"],
    "and the sections past page 80 are in its outline",
  );
});

test("a document is opened once to be converted, however many pages it has", async () => {
  // Opened again for each thing asked of each page, a 513-page manual was parsed over two thousand
  // times and took over a minute: past what a Worker may spend on one message.
  const library = await pdfium();
  let opens = 0;
  const counted = new Proxy(library, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "FPDF_LoadMemDocument64" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        opens += 1;
        return value.apply(target, args);
      };
    },
  });
  const pages = Array.from({ length: 6 }, (_, i) => [{ text: `Page ${i + 1}`, x: 20, y: 180 }]);
  const converted = convertPdf(counted, writtenPdf(pages));
  assert.equal(converted.converted, 6);
  assert.equal(opens, 1);
});

test("a section's heading is a heading, and a line that writes no spaces gets them", async () => {
  // An EPEVER manual sets the number clear of the words and writes no spaces at all: its page came
  // out as a table row reading "Becarefulwheninstallingthebatteries".
  const markdown = markdownOf(
    await charsOfPage([
      ...SHEET,
      { text: "2.2", x: 20, y: 70 },
      { text: "Requirements for the PV array", x: 45, y: 70 },
      { text: "Be", x: 20, y: 55 },
      { text: "careful", x: 37, y: 55 },
      { text: "when", x: 70, y: 55 },
    ]),
  );
  assert.match(markdown, /^2\.2 Requirements for the PV array$/m, markdown);
  assert.match(markdown, /Be careful when/, markdown);
});

test("a document's outline is its headings, each with the page it stands on", async () => {
  const outline = outlineOf(
    await pdfium(),
    writtenPdf([
      [
        { text: "1", x: 20, y: 180 },
        { text: "General information", x: 40, y: 180 },
        { text: "The controller charges a battery from a solar array.", x: 20, y: 160 },
      ],
      [
        { text: "2.2", x: 20, y: 180 },
        { text: "Requirements for the PV array", x: 45, y: 180 },
        { text: "The below table is for reference only.", x: 20, y: 160 },
      ],
    ]),
  );
  assert.deepEqual(
    outline.map((heading) => [heading.page, heading.text]),
    [
      [1, "1 General information"],
      [2, "2.2 Requirements for the PV array"],
    ],
  );
});

test("where a page rules its table, a cell drawn across two columns says its value for both", async () => {
  // EPEVER's specification table merges XTRA1206N and XTRA2206N into one cell for the figures they
  // share. Read from where the text sits, the second model took the value of the model after it —
  // the last wrong value in a manual judged against pictures of its pages. The rules say otherwise.
  const pdf = writtenPdf(
    [
      [
        { text: "Model", x: 20, y: 170 },
        { text: "S-550", x: 110, y: 170 },
        { text: "S-600", x: 210, y: 170 },
        { text: "Weight", x: 20, y: 150 },
        // One value centred on the rule between the two models: a cell drawn across both.
        { text: "42 kg", x: 186, y: 150 },
        { text: "Capacity", x: 20, y: 130 },
        { text: "100 Ah", x: 110, y: 130 },
        { text: "120 Ah", x: 210, y: 130 },
      ],
    ],
    300,
    200,
    [],
    [[100, 200]],
  );
  const library = await pdfium();
  const rules = rulesOn(library, pdf, 1);
  assert.deepEqual(
    rules.map((r) => Math.round(r.x)),
    [100, 200],
  );
  const markdown = markdownOf(charsOn(library, pdf, 1), rules);
  assert.match(markdown, /\| Weight \| 42 kg \| 42 kg \|/, markdown);
  assert.match(markdown, /\| Capacity \| 100 Ah \| 120 Ah \|/, markdown);
});

/** A page's markdown as the converter writes it, rules and all. */
async function ruledPage(page: Placed[], rules: (number | [number, number, number])[]) {
  const library = await pdfium();
  const pdf = writtenPdf([page], 300, 200, [], [rules]);
  return markdownOf(charsOn(library, pdf, 1), rulesOn(library, pdf, 1));
}

/** How many times a piece of text is written. */
const times = (markdown: string, text: string): number => markdown.split(text).length - 1;

/** A table of two models between rules at 100 and 200, from y 100 to 165. */
const MODELS: Placed[] = [
  { text: "Model", x: 20, y: 150 },
  { text: "S-550", x: 110, y: 150 },
  { text: "S-600", x: 210, y: 150 },
  { text: "Weight", x: 20, y: 130 },
  { text: "42 kg", x: 186, y: 130 },
  { text: "Capacity", x: 20, y: 110 },
  { text: "100 Ah", x: 110, y: 110 },
  { text: "120 Ah", x: 210, y: 110 },
];

test("pieces of one line drawn end to end are the line they draw", () => {
  assert.deepEqual(
    joined([
      { x: 100, bottom: 20, top: 40 },
      { x: 100.4, bottom: 41, top: 60 },
      { x: 100, bottom: 90, top: 100 },
      { x: 200, bottom: 20, top: 40 },
    ]).map((r) => [Math.round(r.x), r.bottom, r.top]),
    [
      [100, 20, 60],
      [100, 90, 100],
      [200, 20, 40],
    ],
  );
  assert.deepEqual(joined([]), []);
});

test("a table ruled a row at a time is read by the lines its pieces draw", async () => {
  const library = await pdfium();
  const pdf = writtenPdf(
    [[{ text: "Model", x: 20, y: 150 }]],
    300,
    200,
    [],
    [
      [
        [100, 20, 40],
        [100, 40, 60],
        [100, 90, 100],
      ],
    ],
  );
  // Within the width of the stroke: PDFium's bounds take in the line's ends.
  const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
  const rules = rulesOn(library, pdf, 1);
  assert.equal(rules.length, 2, JSON.stringify(rules));
  for (const [rule, [x, bottom, top]] of rules.map(
    (r, i) =>
      [
        r,
        [
          [100, 20, 60],
          [100, 90, 100],
        ][i],
      ] as const,
  ))
    assert.ok(
      near(rule.x, x ?? 0) && near(rule.bottom, bottom ?? 0) && near(rule.top, top ?? 0),
      JSON.stringify(rules),
    );
});

test("the strokes of letters drawn as shapes are not a table's rules", async () => {
  // Victron's off-grid booklet draws some letters as shapes: 57 upright strokes on one page, each
  // as tall as a letter. Taken for rules, they cut every sentence on the page into columns and
  // wrote it into each: one of its sentences 14 times.
  const sentence = "Read the manual before you install the inverter";
  const lines = [170, 150, 130, 110];
  const markdown = await ruledPage(
    lines.map((y) => ({ text: sentence, x: 20, y })),
    lines.flatMap((y) =>
      [60, 110, 160, 210].map((x): [number, number, number] => [x, y - 1, y + 6]),
    ),
  );
  assert.equal(times(markdown, sentence), 4, markdown);
  assert.ok(!markdown.includes("|"), markdown);
});

test("a sentence above a ruled table is written once, and the table's shared cell under both columns", async () => {
  // Across one of the table's rules and not the other: a line as wide as the table is said once
  // whatever the rules, so only a narrower one shows whether the rules reach it.
  const sentence = "Read this manual first.";
  const markdown = await ruledPage(
    [{ text: sentence, x: 20, y: 185 }, ...MODELS],
    [
      [100, 100, 165],
      [200, 100, 165],
    ],
  );
  assert.equal(times(markdown, sentence), 1, markdown);
  assert.match(markdown, /\| Weight \| 42 kg \| 42 kg \|/, markdown);
});

test("a rule broken to the foot of its table still divides the rows under it", async () => {
  // EPEVER's rule between XTRA1206N and XTRA2206N stops above its last rows, where the two share
  // their static losses in one cell. Taken as only as tall as it is drawn, the shared value was left
  // under the first model alone.
  const markdown = await ruledPage(
    [
      { text: "Model", x: 20, y: 150 },
      { text: "S-550", x: 110, y: 150 },
      { text: "S-600", x: 210, y: 150 },
      { text: "Weight", x: 20, y: 130 },
      { text: "42 kg", x: 110, y: 130 },
      { text: "51 kg", x: 210, y: 130 },
      { text: "Capacity", x: 20, y: 110 },
      { text: "100 Ah", x: 186, y: 110 },
    ],
    [
      [100, 100, 165],
      [200, 125, 165],
    ],
  );
  assert.match(markdown, /\| Capacity \| 100 Ah \| 100 Ah \|/, markdown);
});

test("the sides of boxes are not a table's rules, and do not make two boxes one table", async () => {
  // A Rolls installation guide boxes its reference documents at the top of a page and a table at
  // the foot, and draws the sides of both as one line down the page. Taken for rules, the sides made
  // the page one table, and the sentence between the boxes was written into its columns.
  const sentence = "Refer to the manufacturer for the latest documents.";
  const markdown = await ruledPage(
    [
      { text: "Victron docs", x: 20, y: 188 },
      { text: "Rolls docs", x: 160, y: 188 },
      { text: "Manual", x: 20, y: 177 },
      { text: "Datasheet", x: 160, y: 177 },
      { text: sentence, x: 20, y: 160 },
      { text: "Weight", x: 20, y: 130 },
      { text: "42 kg", x: 110, y: 130 },
      { text: "51 kg", x: 210, y: 130 },
      { text: "Capacity", x: 20, y: 110 },
      { text: "100 Ah", x: 110, y: 110 },
      { text: "120 Ah", x: 210, y: 110 },
    ],
    [
      [15, 100, 198],
      [285, 100, 198],
      [150, 172, 198],
      [100, 100, 145],
      [200, 100, 145],
    ],
  );
  assert.equal(times(markdown, sentence), 1, markdown);
  for (const value of ["42 kg", "51 kg", "100 Ah", "120 Ah"])
    assert.equal(times(markdown, value), 1, markdown);
});

test("a note as wide as its table is written once, not into each column", async () => {
  const note = "Values measured at 25 degrees C unless stated.";
  const markdown = await ruledPage(
    [...MODELS, { text: note, x: 20, y: 95 }],
    [
      [100, 88, 165],
      [200, 88, 165],
    ],
  );
  assert.equal(times(markdown, note), 1, markdown);
  assert.match(markdown, /\| Capacity \| 100 Ah \| 120 Ah \|/, markdown);
});

test("a rule drawn only on the rows it divides still opens its column", async () => {
  // OutBack's FLEXmax settings divide their 24, 36 and 48 volt columns only on the rows that set a
  // value for each: pieces a row tall, a third taller than the letters beside them.
  const markdown = await ruledPage(
    [
      { text: "Low battery", x: 20, y: 150 },
      { text: "23.0 Vdc", x: 110, y: 150 },
      { text: "34.5 Vdc", x: 210, y: 150 },
      { text: "Range", x: 20, y: 130 },
      { text: "20 to 68 Vdc", x: 110, y: 130 },
      { text: "High battery", x: 20, y: 110 },
      { text: "28.0 Vdc", x: 110, y: 110 },
      { text: "42.0 Vdc", x: 210, y: 110 },
    ],
    [
      [100, 95, 165],
      [200, 146, 158],
      [200, 106, 118],
    ],
  );
  assert.match(markdown, /\| Low battery \| 23\.0 Vdc \| 34\.5 Vdc \|/, markdown);
  assert.match(markdown, /\| High battery \| 28\.0 Vdc \| 42\.0 Vdc \|/, markdown);
});

test("short upright marks level with the text are not rules, even where text stands either side", async () => {
  // Letters drawn as shapes at the same place on each line of a table: text stands on both sides of
  // them, as it does of a rule, but none is taller than the letters. Taken for rules, they cut the
  // note under the table into two columns and wrote it into both.
  const note = "See page 12 for the wiring.";
  const rows = [160, 140, 120, 100];
  const markdown = await ruledPage(
    [
      { text: "Model", x: 20, y: 160 },
      { text: "S-550", x: 110, y: 160 },
      { text: "S-600", x: 210, y: 160 },
      { text: "Weight", x: 20, y: 140 },
      { text: "42 kg", x: 110, y: 140 },
      { text: "51 kg", x: 210, y: 140 },
      { text: "Capacity", x: 20, y: 120 },
      { text: "100 Ah", x: 110, y: 120 },
      { text: "120 Ah", x: 210, y: 120 },
      { text: note, x: 20, y: 100 },
    ],
    rows.flatMap((y) => [100, 200].map((x): [number, number, number] => [x, y - 1, y + 5])),
  );
  assert.equal(times(markdown, note), 1, markdown);
  assert.match(markdown, /\| Weight \| 42 kg \| 51 kg \|/, markdown);
});
test("a page that is mostly a picture is marked, so its labels are read as labels", async () => {
  // EPEVER's appendix gives an efficiency curve a page at a time, headed with the conditions it was
  // measured at — "Solar Module MPP Voltage (17V, 34V)/Nominal System Voltage (13V)". Read as a
  // table, ten such headings in sixty figures became ratings of the controller.
  const pdf = writtenPdf(
    [
      [{ text: "Nominal System Voltage (13V)", x: 20, y: 180 }],
      [{ text: "Rated charging current 20A", x: 20, y: 180 }],
    ],
    300,
    200,
    // Half of the first page is the curve; the second page has no picture at all.
    [0.5, 0],
  );
  const library = await pdfium();
  assert.ok(picturesOn(library, pdf, 1) >= MOSTLY_DRAWN, String(picturesOn(library, pdf, 1)));
  assert.equal(picturesOn(library, pdf, 2), 0);
  const markdown = markdownOfDocument(library, pdf);
  assert.match(
    markdown,
    /### Page 1\n_This page is mostly a picture; the text on it labels what is drawn\._/,
  );
  assert.ok(!/### Page 2\n_This page is mostly a picture/.test(markdown), markdown);
  // What that mark means is said in the prompt.
  assert.match(SYSTEM, /A PAGE THAT IS A PICTURE\./);
  assert.match(SYSTEM, /conditions a curve was measured at/);
});

test("what a page's pictures cover is what they cover between them, on the page", async () => {
  const page = [{ text: "Rated charging current 20A", x: 20, y: 180 }];
  const library = await pdfium();
  // One picture over another covers what one of them covers, not twice as much.
  const twice = writtenPdf(
    [page],
    300,
    200,
    [],
    [],
    [
      [
        [0, 0, 120, 200],
        [0, 0, 120, 200],
      ],
    ],
  );
  assert.ok(
    Math.abs(picturesOn(library, twice, 1) - 0.4) < 0.05,
    String(picturesOn(library, twice, 1)),
  );
  // A picture hanging off the page covers only the part of the page it is on.
  const over = writtenPdf([page], 300, 200, [], [], [[[240, 0, 300, 200]]]);
  assert.ok(
    Math.abs(picturesOn(library, over, 1) - 0.2) < 0.05,
    String(picturesOn(library, over, 1)),
  );
  // Both would have passed for a page of drawings when their areas were added up.
  assert.ok(picturesOn(library, twice, 1) < MOSTLY_DRAWN + 0.11);
});

test("a page drawn as a picture has no characters to read, and is left to the page reader", async () => {
  assert.deepEqual(charsOn(await pdfium(), tinyPdf([BLACK_BOX]), 1), []);
  assert.equal(markdownOf([]), "");
  // Nor is it called a picture: the notice would be the only text the document had, and a scan
  // would be stored as converted rather than drawn by the page reader.
  const scan = markdownOfDocument(await pdfium(), tinyPdf([GREY_SCAN]));
  assert.ok(!scan.includes("mostly a picture"), scan);
  assert.equal(textLayer(scan).characters, 0);
});

test("a section is given with the words it opens with, so its name is not all there is to judge", () => {
  const markdown = [
    "### Page 15",
    "2.2 Requirements for the PV array",
    "The below table is for reference only.",
    "|  | | |",
    "|---|---|---|",
    "| 12V | 1 | 1 |",
    "### Page 17",
    "2.3 Wire size and circuit breaker",
    "| Model | XTRA1206N | XTRA2206N |",
    "| Rated charge current | 10A | 20A |",
  ].join("\n");
  const sections = withOpenings(markdown, [
    { title: "2.2 Requirements for the PV array", from: 15, to: 16 },
    { title: "2.3 Wire size and circuit breaker", from: 17, to: 18 },
    { title: "5 Nothing of that name", from: 19, to: 20 },
  ]);
  assert.match(sections[0]?.opening ?? "", /^The below table is for reference only\./);
  assert.match(sections[1]?.opening ?? "", /Rated charge current \| 10A \| 20A/);
  assert.ok((sections[0]?.opening?.length ?? 0) <= OPENING);
  // A heading the markdown does not carry leaves the section as it was, rather than guessing.
  assert.equal(sections[2]?.opening, undefined);
});

test("a document's sections run from their heading to the next one no deeper", async () => {
  const outline = [
    { page: 5, text: "1 General information", size: 12 },
    { page: 8, text: "1.1 Overview", size: 10 },
    { page: 13, text: "2 Installation", size: 12 },
    { page: 15, text: "2.2 Requirements for the PV array", size: 10 },
    { page: 49, text: "6 Technical Specifications", size: 12 },
  ];
  assert.deepEqual(
    sectionsOf(outline, 54).map((s) => [s.title, s.from, s.to]),
    [
      // What stands before the first heading is a section: a datasheet states its figures there.
      ["", 1, 4],
      ["1 General information", 5, 12],
      ["1.1 Overview", 8, 12],
      ["2 Installation", 13, 48],
      ["2.2 Requirements for the PV array", 15, 48],
      ["6 Technical Specifications", 49, 54],
    ],
  );
  // A document with no headings is one section: the whole of it.
  assert.deepEqual(sectionsOf([], 3), [{ title: "", from: 1, to: 3 }]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ReadWindow, readDocument } from "../src/extract.ts";
import {
  answerObjects,
  asciiSymbols,
  CHUNK_CHARACTERS,
  CONVERTER,
  chunk,
  DOCUMENT_FIGURES_SYSTEM,
  EXTRACT_MODEL,
  EXTRACTOR_ID,
  mergeReports,
  namesOneProduct,
  pageOfFigure,
  pageOffsets,
  printedSymbols,
  type Reported,
  SYSTEM,
  statesOneFigure,
} from "../src/reading.ts";
import { LAST_ATTEMPT, partKey, readerKey } from "../src/work.ts";
import { type TestAiInput, world } from "./world.ts";

test("a short document is one window, and an empty one is none", () => {
  assert.deepEqual(chunk("short"), [{ text: "short" }]);
  assert.deepEqual(chunk("   "), []);
  assert.deepEqual(chunk(""), []);
});

test("a window carries the page it starts on, so a figure can be checked against the document", () => {
  const doc = `### Page 1\n${"a".repeat(80)}\n### Page 2\n${"b".repeat(80)}\n### Page 3\n${"c".repeat(80)}`;
  assert.deepEqual(
    pageOffsets(doc).map((p) => p.page),
    [1, 2, 3],
  );
  const windows = chunk(doc, 100, 10);
  assert.deepEqual(windows[0].page, 1);
  assert.ok(
    windows.some((w) => w.page === 2),
    "a later window reports the page it began in",
  );
  assert.equal(
    chunk("no page headings here at all")[0].page,
    undefined,
    "a document with no page markers gives no page, rather than page one",
  );
});

/** A window that starts on page 4 and runs on over pages 5 and 6. */
const RUNS_ON = {
  page: 4,
  text: [
    "4 cells in series.",
    "### Page 5",
    "| Nominal voltage | 12.8 V |",
    "### Page 6",
    "| Weight | 11 kg |",
  ].join("\n"),
};

test("a figure cites the page its value is printed on, not the page its window starts on", () => {
  assert.equal(pageOfFigure(RUNS_ON, { name: "Weight", value: "11" }), 6);
  assert.equal(
    pageOfFigure(RUNS_ON, { name: "Nominal voltage", value: "12.8" }),
    5,
    "the last marker before the value, not the last in the window",
  );
});

test("a value printed before the window's first page marker keeps the window's page", () => {
  assert.equal(pageOfFigure(RUNS_ON, { name: "Cells", value: "4" }), 4);
  // The first window of a converted PDF starts in its title and metadata, which are on no page.
  const first = {
    text: "# sheet.pdf\n## Metadata\n- PageCount=2\n- PDFFormatVersion=1.7\n\n## Contents\n### Page 1\nIntro\n### Page 2\n| Cells | 2 |",
  };
  assert.equal(
    pageOfFigure(first, { name: "Cells", value: "2" }),
    2,
    "a value in the metadata is passed over for the page that prints it",
  );
  assert.equal(pageOfFigure(first, { name: "PDF version", value: "1.7" }), undefined);
});

test("a value that is not printed in the window keeps the window's page, or none", () => {
  assert.equal(pageOfFigure(RUNS_ON, { name: "Float voltage", value: "13.6" }), 4);
  assert.equal(
    pageOfFigure({ text: RUNS_ON.text }, { name: "Float voltage", value: "13.6" }),
    undefined,
  );
});

test("a value printed on two pages is taken where it is printed first, unless its name is beside a later one", () => {
  const window = {
    page: 1,
    text: "### Page 1\nCharge at 14.4 V for a full battery.\n### Page 2\nSee the table.\n### Page 3\n| Absorption voltage | 14.4 V |",
  };
  assert.equal(pageOfFigure(window, { name: "Charge voltage", value: "14.4" }), 1);
  assert.equal(pageOfFigure(window, { name: "Absorption voltage", value: "14.4" }), 3);
});

test("a figure's name is looked for only when its value is not printed", () => {
  const window = {
    page: 7,
    text: "### Page 7\nWeight is listed with the dimensions.\n### Page 8\n| Mass | 11 kg |\n### Page 9\n| Terminal torque | 9 N·m |",
  };
  assert.equal(
    pageOfFigure(window, { name: "Weight", value: "11" }),
    8,
    "the value is printed, so the name printed a page earlier is not used",
  );
  assert.equal(
    pageOfFigure(window, { name: "Terminal torque", value: "9.0" }),
    9,
    "the value is written differently, so its name gives the page",
  );
});

test("a value is found whole across a change of whitespace, and not inside a longer number, a name or a page marker", () => {
  const window = {
    page: 1,
    text: "### Page 1\n| Model | RM-12 |\n| Capacity | 120 Ah |\n| Voltage | 12.8 V |\n### Page 2\n| Charger | 12V |\n| Size | 216 x  295\nx 103 mm |",
  };
  assert.equal(pageOfFigure(window, { name: "Charger voltage", value: "12" }), 2);
  assert.equal(pageOfFigure(window, { name: "Dimensions", value: "216 x 295 x 103" }), 2);
  assert.equal(
    pageOfFigure(window, { name: "Cells", value: "2" }),
    1,
    "the 2 of the page 2 marker is not a figure",
  );
});

test("windows overlap, so a ratings table across a boundary is still seen whole once", () => {
  const text = "x".repeat(CHUNK_CHARACTERS * 2);
  const windows = chunk(text, 100, 20);
  assert.ok(windows.length > 1);
  for (let i = 1; i < windows.length; i += 1) assert.equal(windows[i].text.length <= 100, true);
  const covered = windows.map((w) => w.text).join("").length;
  assert.ok(covered > text.length, "overlap means the windows together are longer than the text");
});

test("a product named by two windows becomes one entry, and a repeated figure is not repeated", () => {
  const merged = mergeReports([
    {
      model: "S-550",
      specs: [{ name: "Rated capacity", value: "428", unit: "Ah", conditions: "20h" }],
    },
    {
      model: "s-550",
      specs: [
        { name: "Rated capacity", value: "428", unit: "Ah", conditions: "20h" },
        { name: "Nominal voltage", value: "6", unit: "V" },
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].specs.length, 2);
  assert.equal(merged[0].model, "S-550", "the first spelling is kept");
});

test("the same figure under different conditions is kept twice, because it is two facts", () => {
  const merged = mergeReports([
    {
      model: "S-550",
      specs: [
        { name: "Rated capacity", value: "428", unit: "Ah", conditions: "20-hour rate" },
        { name: "Rated capacity", value: "556", unit: "Ah", conditions: "100-hour rate" },
      ],
    },
  ]);
  assert.equal(merged[0].specs.length, 2);
});

test("a product with no readable figures, or a malformed entry, is dropped rather than stored empty", () => {
  assert.deepEqual(mergeReports([{ model: "X", specs: [] }]), []);
  assert.deepEqual(mergeReports([{ model: "  ", specs: [{ name: "a", value: "1" }] }]), []);
  assert.deepEqual(mergeReports([{ model: "X", specs: [{ name: 1 as never, value: "1" }] }]), []);
});

test("a series is not a model, because its figures belong to its members", () => {
  assert.equal(namesOneProduct("XTRA4210N"), true);
  assert.equal(namesOneProduct("S48-100LFP STACK-LV"), true);
  assert.equal(namesOneProduct("MS Series"), false);
  assert.equal(namesOneProduct("CSW SERIES"), false);
  assert.equal(namesOneProduct("Freedom SW product family"), false);
  assert.equal(namesOneProduct(""), false);
  assert.deepEqual(
    mergeReports([{ model: "MSH-M Series", specs: [{ name: "Power factor", value: "0.95" }] }]),
    [],
  );
});

test("three products' figures written together are not one value", () => {
  assert.equal(statesOneFigure("428"), true);
  assert.equal(statesOneFigure("12/24"), true);
  assert.equal(
    statesOneFigure("216 x 295 x 103mm"),
    true,
    "a dimension is one measurement, not a list",
  );
  assert.equal(statesOneFigure("400 W, 1000 W, and 2000 W"), false);
  assert.equal(statesOneFigure("10,000 amperes at 160VDC and 65,000 amperes at 65VDC"), false);
  assert.equal(statesOneFigure(""), false);
  const merged = mergeReports([
    {
      model: "EV-1200",
      specs: [
        { name: "Continuous power", value: "1200", unit: "W" },
        { name: "Output", value: "400 W, 1000 W and 2000 W" },
      ],
    },
  ]);
  assert.deepEqual(
    merged[0].specs.map((s) => s.value),
    ["1200"],
  );
});

// ---- reading a document ----

const SHA = "e".repeat(64);
const MARKDOWN = partKey.markdown(SHA, CONVERTER);
const READER = readerKey(EXTRACTOR_ID);
const readingKey = partKey.reading(SHA, READER);
const windowKey = (window: number) => partKey.window(SHA, READER, window);
const message = {
  kind: "extract" as const,
  run: "2026-09-10-aaaaaaaa",
  manufacturer: "maker",
  date: "2026-09-10",
  sha256: SHA,
  url: "https://maker.test/sheet.pdf",
  key: MARKDOWN,
};

/** Three pages of a converted sheet, long enough for three windows. */
const SHEET = [1, 2, 3].map((page) => `### Page ${page}\n${"x".repeat(5000)}\n`).join("");
const WINDOWS = chunk(SHEET);

interface Reading {
  products: Reported[];
  windows: number;
  failed: number;
}

/**
 * A model that names one product in each window it is shown, with a page of its own invention, and
 * answers the windows in `broken` with an answer cut short.
 */
function reader(broken: Set<number> = new Set()) {
  return (_call: number, input: TestAiInput): unknown => {
    // The message names the document's maker first (#144), and what follows is the window.
    const content = String(input.messages[1].content);
    assert.match(content, /^Maker: maker\n\n/);
    const shown = content.slice(content.indexOf("\n\n") + 2);
    const window = WINDOWS.findIndex((w) => w.text === shown) + 1;
    if (broken.has(window))
      return { response: '{"products":[{"model":"S-550","specs":[{"name":"Rated' };
    return {
      response: JSON.stringify({
        products: [
          { model: `S-${500 + window * 50}`, specs: [{ name: "Weight", value: "42 kg", page: 9 }] },
        ],
      }),
    };
  };
}

test("a sheet is read a window at a time, each window kept, and the reading written once all are in", async () => {
  assert.equal(WINDOWS.length, 3);
  const { env, asked, readObject } = world({ [MARKDOWN]: SHEET }, reader());
  await readDocument(message, env, 1);
  assert.equal(asked.length, 3);
  assert.ok(asked.every((a) => a.model === EXTRACT_MODEL));
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual([reading.windows, reading.failed], [3, 0]);
  assert.deepEqual(
    reading.products.map((p) => [p.model, p.specs[0].page]),
    WINDOWS.map((w, i) => [`S-${550 + i * 50}`, w.page]),
    "a figure whose value the window does not print has the page its window starts on, never the model's",
  );
  assert.equal(readObject<ReadWindow>(windowKey(2)).products[0].model, "S-600");

  await readDocument(message, env, 1);
  assert.equal(asked.length, 3, "a document read before is not read again");
});

test("a figure in a reading cites the page its value is printed on, and never the model's page", async () => {
  const answer = () => ({
    response: JSON.stringify({
      products: [{ model: "S-550", specs: [{ name: "Weight", value: "42", unit: "kg", page: 9 }] }],
    }),
  });
  const unpaged = world({ [MARKDOWN]: "| Weight | 42 kg |\n" }, answer);
  await readDocument(message, unpaged.env, 1);
  assert.deepEqual(
    unpaged.readObject<Reading>(readingKey).products[0]?.specs.map((s) => s.page),
    [undefined],
    "a document with no page markers gives no page, whatever page the model claims",
  );

  const paged = `### Page 1\nThe S-550 is a deep-cycle battery.\n### Page 2\n| Weight | 42 kg |\n`;
  const first = world({ [MARKDOWN]: paged }, answer);
  await readDocument(message, first.env, 1);
  assert.deepEqual(
    first.readObject<Reading>(readingKey).products[0]?.specs.map((s) => s.page),
    [2],
    "the table is on page 2, below the window's start on page 1",
  );
});

test("an answer cut short is left for the queue, and the next delivery reads only the window missed", async () => {
  const broken = new Set([2]);
  const { env, asked, read, readObject } = world({ [MARKDOWN]: SHEET }, reader(broken));
  await assert.rejects(readDocument(message, env, 1), {
    message: /^1 of 3 windows not read; window 2: Unterminated string in JSON/,
  });
  assert.equal(asked.length, 3, "the windows after the failed one are still read");
  assert.equal(read(readingKey), undefined, "no reading with a window missing");
  assert.equal(read(windowKey(2)), undefined, "and nothing written that would stop the retry");
  assert.ok(read(windowKey(1)) && read(windowKey(3)));

  broken.clear();
  await readDocument(message, env, 2);
  assert.equal(asked.length, 4, "one more call, for window 2 alone");
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual(
    [reading.failed, reading.products.map((p) => p.model)],
    [0, ["S-550", "S-600", "S-650"]],
  );
});

test("a window that fails on the last attempt is written down, and the reading still finishes", async () => {
  const { env, readObject } = world({ [MARKDOWN]: SHEET }, reader(new Set([2])));
  await readDocument(message, env, LAST_ATTEMPT);
  assert.match(readObject<ReadWindow>(windowKey(2)).failed ?? "", /^not read: Unterminated string/);
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual(
    [reading.windows, reading.failed, reading.products.map((p) => p.model)],
    [3, 1, ["S-550", "S-650"]],
  );
});

test("a window kept past this message's budget is not counted in its reading", async () => {
  const kept: ReadWindow = {
    window: 3,
    products: [{ model: "S-999", specs: [{ name: "Weight", value: "1 kg" }] }],
  };
  const { env, asked, readObject } = world(
    { [MARKDOWN]: SHEET, [windowKey(3)]: `${JSON.stringify(kept)}\n` },
    reader(),
  );
  await readDocument({ ...message, maxWindows: 2 }, env, 1);
  assert.equal(asked.length, 2);
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual(
    [reading.windows, reading.products.map((p) => p.model)],
    [2, ["S-550", "S-600"]],
  );
});

test("more windows kept than one listing returns are all found, so only the missing one is read", async () => {
  // 1,002 windows, the first 1,001 kept by an earlier delivery: past the 1,000 keys R2 lists at once.
  const long = "x".repeat(5400 * 1001 + 6000);
  const count = chunk(long).length;
  assert.equal(count, 1002);
  const objects: Record<string, string> = { [MARKDOWN]: long };
  for (let window = 1; window < count; window += 1)
    objects[windowKey(window)] = `${JSON.stringify({ window, products: [] })}\n`;
  const { env, asked, readObject } = world(objects, () => ({
    response: JSON.stringify({ products: [] }),
  }));
  await readDocument({ ...message, maxWindows: count }, env, 1);
  assert.equal(asked.length, 1, "window 1,002 alone");
  assert.equal(readObject<Reading>(readingKey).windows, count);
});

test("both readers are told to carry a table's header unit into each figure and to report a battery's chemistry", () => {
  for (const prompt of [SYSTEM, DOCUMENT_FIGURES_SYSTEM]) {
    assert.match(prompt, /column header|heading of the column/, "a unit printed once for a column");
    assert.match(
      prompt,
      /figure named "Chemistry"/,
      "the chemistry as a figure the records can cite",
    );
    assert.match(
      prompt,
      /Do not report one the document does not (state|print)/,
      "and never an invented one",
    );
  }
});

test("both readers are told a maker's settings, screens, examples and other companies' products are not its ratings (#144)", () => {
  for (const prompt of [SYSTEM, DOCUMENT_FIGURES_SYSTEM]) {
    assert.match(prompt, /The message starts with the maker whose document this is/);
    assert.match(
      prompt,
      /settings it recommends for another company's battery, inverter or charger/,
    );
    assert.match(prompt, /values drawn on a screen, display or app in an illustration/);
    assert.match(prompt, /worked example/);
    assert.match(prompt, /another company's products listed beside its own/);
  }
});

test("the text reader tells the model whose document it reads, by the maker's name or else its id", async () => {
  const nothing = () => ({ response: JSON.stringify({ products: [] }) });
  const named = world({ [MARKDOWN]: SHEET }, nothing);
  await readDocument({ ...message, manufacturer: "victron-energy" }, named.env, 1);
  assert.match(String(named.asked[0]?.input.messages[1]?.content), /^Maker: Victron Energy\n\n/);
  const unlisted = world({ [MARKDOWN]: SHEET }, nothing);
  await readDocument({ ...message, manufacturer: "nobody-listed" }, unlisted.env, 1);
  assert.match(
    String(unlisted.asked[0]?.input.messages[1]?.content),
    /^Maker: nobody-listed\n\n/,
    "a maker the bundled list does not name is given by its id",
  );
});

test("the text reader gives the answer's shape in its prompt and holds the model to no schema", async () => {
  const { env, asked } = world({ [MARKDOWN]: SHEET }, reader());
  await readDocument(message, env, 1);
  assert.equal(asked.length, 3);
  for (const { input } of asked) {
    assert.equal(
      input.response_format,
      undefined,
      "held to a schema, the model answered windows it reads in full with an empty list",
    );
    assert.equal(input.max_tokens, 8192, "room for the answer to a dense table of several models");
  }
  assert.match(
    SYSTEM,
    /Reply with JSON only, no prose: \{"products":\[\{"model":"\.\.\.","specs":\[\{"name":"\.\.\.","value":"\.\.\.","unit":"\.\.\.","conditions":"\.\.\."\}\]\}\]\}/,
  );
});

test("an answer's JSON objects are read past a note or a second object, and one cut short still throws", () => {
  assert.deepEqual(answerObjects('{"products":[]}'), [{ products: [] }]);
  assert.deepEqual(
    answerObjects('{"products":[]}\n\n{"products":[{"model":"S-550","specs":[]}]}'),
    [{ products: [] }, { products: [{ model: "S-550", specs: [] }] }],
    "an empty answer and then the real one keeps both",
  );
  assert.deepEqual(
    answerObjects(
      'Ratings:\n{"products":[{"model":"12\\" {x} ]","specs":[]}]}\nNote: no units are printed.',
    ),
    [{ products: [{ model: '12" {x} ]', specs: [] }] }],
    "text around the object is left out, and a brace or an escaped quote inside a string ends nothing",
  );
  assert.throws(
    () => answerObjects('{"products":[]} {"products":[{"model":"S-5'),
    /Unterminated string in JSON/,
    "an object cut short after a whole one still fails the window",
  );
  assert.throws(() => answerObjects("The S-550 weighs 42 kg."), /Unexpected token/);
  assert.throws(() => answerObjects(""), SyntaxError, "and so does no answer at all");
});

test("a window whose answer has a note or a second object after its JSON is read, not failed", async () => {
  const product = { model: "S-550", specs: [{ name: "Weight", value: "42 kg" }] };
  const { env, readObject } = world({ [MARKDOWN]: "| Weight | 42 kg |\n" }, () => ({
    response: `{"products":[]}\n${JSON.stringify({ products: [product] })}\nNote: the weight is per unit.`,
  }));
  await readDocument(message, env, 1);
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual(
    [reading.failed, reading.products.map((p) => [p.model, p.specs[0]?.value])],
    [0, [["S-550", "42 kg"]]],
  );
});

test("an answer in a code fence is read, and prose in place of JSON leaves the window for the queue", async () => {
  const sheet = "| Weight | 42 kg |\n";
  const answer = { products: [{ model: "S-550", specs: [{ name: "Weight", value: "42 kg" }] }] };
  const fenced = world({ [MARKDOWN]: sheet }, () => ({
    response: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
  }));
  await readDocument(message, fenced.env, 1);
  assert.deepEqual(
    fenced.readObject<Reading>(readingKey).products.map((p) => [p.model, p.specs[0]?.value]),
    [["S-550", "42 kg"]],
  );

  const prose = world({ [MARKDOWN]: sheet }, () => ({ response: "The S-550 weighs 42 kg." }));
  await assert.rejects(readDocument(message, prose.env, 1), {
    message: /^1 of 1 windows not read; window 1: Unexpected token/,
  });
  assert.equal(prose.read(readingKey), undefined, "no reading from an answer that is not JSON");
  assert.equal(prose.read(windowKey(1)), undefined, "and no window kept to stop the retry");
});

test("the symbols the reader garbles are spelled in ASCII for it, and given back in what it reports (#145)", () => {
  assert.equal(
    asciiSymbols("≥8000 cycles, VSWR ≤ 2.0, 9～17V"),
    ">=8000 cycles, VSWR <= 2.0, 9~17V",
  );
  assert.equal(printedSymbols("≥8000 cycles, VSWR ≤ 2.0", "VSWR <= 2.0"), "VSWR ≤ 2.0");
  assert.equal(asciiSymbols("12/24 V"), "12/24 V", "text with none of them is left as it is");
  assert.equal(
    printedSymbols("9～17V", "9~17V"),
    "9~17V",
    "a tilde stays, since it reads the same in a range",
  );
  assert.equal(
    printedSymbols("Charge temperature >=0°C", ">=0°C"),
    ">=0°C",
    "an operator the sheet prints in ASCII is kept",
  );
  assert.equal(
    printedSymbols("Cycle life ≥8000 cycles at 25°C", ">=8000 cycles"),
    "≥8000 cycles",
    "words not printed as reported are given the symbol when the text has no ASCII operator",
  );
  assert.equal(
    printedSymbols("VSWR >=1.5 and ≤2.0", ">= 2.0"),
    ">= 2.0",
    "and keep what the model wrote when the text has one it could have copied",
  );
});

test("a figure printed with an ASCII operator or a full-width tilde keeps its page when its name is reworded (#145)", async () => {
  const sheet =
    "### Page 1\nSee the next page.\n### Page 2\n| Charge temperature | >=0°C |\n| Input | 9～17V |\n";
  const { env, readObject } = world({ [MARKDOWN]: sheet }, () => ({
    response: JSON.stringify({
      products: [
        {
          model: "S-550",
          specs: [
            { name: "Charging temperature", value: ">=0°C" },
            { name: "Input voltage range", value: "9~17V" },
          ],
        },
      ],
    }),
  }));
  await readDocument(message, env, 1);
  assert.deepEqual(
    readObject<Reading>(readingKey).products[0]?.specs.map((s) => [s.value, s.page]),
    [
      [">=0°C", 2],
      ["9~17V", 2],
    ],
  );
});

test("the text reader sends a window without the symbols it garbles, and a figure keeps the symbol and page its document prints", async () => {
  const sheet =
    "### Page 1\nSee the next page.\n### Page 2\n| Cycle life | ≥8000 cycles |\n| Self-discharge | ≤3%/month |\n";
  const { env, asked, readObject } = world({ [MARKDOWN]: sheet }, (_call, input) => {
    assert.doesNotMatch(String(input.messages[1]?.content), /[≥≤～]/);
    return {
      response: JSON.stringify({
        products: [
          {
            model: "S-550",
            specs: [
              { name: "Cycle life", value: ">=8000 cycles" },
              { name: "Self-discharge", value: "<=3%/month" },
            ],
          },
        ],
      }),
    };
  });
  await readDocument(message, env, 1);
  assert.equal(asked.length, 1);
  assert.deepEqual(
    readObject<Reading>(readingKey).products[0]?.specs.map((s) => [s.value, s.page]),
    [
      ["≥8000 cycles", 2],
      ["≤3%/month", 2],
    ],
  );
});

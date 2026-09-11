import type { Reported } from "../src/reading.ts";
import type { ReadWindow, SeenPage } from "../src/vision.ts";

interface Reading {
  products: Reported[];
  pages: number;
  failed: number;
  transcript?: string;
  extractedBy: string;
  url: string;
  refused?: string;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { visionRun } from "../src/enqueue.ts";
import {
  CONVERTER,
  chunk,
  DOCUMENT_FIGURES_SYSTEM,
  EXTRACTOR_ID,
  FIGURE_WINDOW_CHARACTERS,
  figureWindows,
  hasTextLayer,
  MAX_PAGES,
  MAX_RENDER_BYTES,
  mergeReports,
  notTranscribed,
  PAGE_CONVERTER,
  pageOffsets,
  RESPONSE_SCHEMA,
  reportsInWindow,
  TRANSCRIPT_SCHEMA,
  textLayer,
  transcriptDocument,
  transcriptOf,
  VISION_EXTRACTOR_ID,
  VISION_MODEL,
  VISION_RESPONSE_SCHEMA,
  windowPrompt,
  withoutPageHeadings,
} from "../src/reading.ts";
import { MAX_WAITS, seeDocument, seePage, seeWindow, waitFor } from "../src/vision.ts";
import { LAST_ATTEMPT, partKey, readerKey, type Work } from "../src/work.ts";
import { BLACK_BOX, pdfium, tinyPdf } from "./pdf.ts";
import { type TestAiInput, world } from "./world.ts";

/** What `toMarkdown` gave a scanned Pentair sheet, byte for byte apart from the name. */
const SCANNED = `# 48513.pdf
## Metadata
- PDFFormatVersion=1.4
- IsLinearized=true
- IsAcroFormPresent=false
- ModDate=D:20060808160302-05'00'
- Producer=



## Contents
### Page 1



`;

const withText = (pages: string[]): string =>
  `# a.pdf\n## Metadata\n- Title=A datasheet\n\n## Contents\n${pages.map((p, i) => `### Page ${i + 1}\n${p}\n`).join("")}`;

test("a conversion with page headings and nothing under them has no text layer", () => {
  assert.deepEqual(textLayer(SCANNED), { pages: 1, characters: 0 });
  assert.equal(hasTextLayer(textLayer(SCANNED)), false);
  assert.equal(
    hasTextLayer(
      textLayer(
        withText(["Nominal voltage 48 V. Rated capacity 100 Ah at C/5, 25 °C. Weight 42 kg."]),
      ),
    ),
    true,
  );
});

test("the converter's own title and metadata are not text the document holds", () => {
  const verbose = SCANNED.replace(
    "- Producer=",
    `- Subject=${"A very long subject line. ".repeat(40)}\n- Producer=`,
  );
  assert.equal(
    textLayer(verbose).characters,
    0,
    "a long metadata block still leaves the pages empty",
  );
  assert.equal(hasTextLayer(textLayer(verbose)), false);
});

test("a page number or a stamp on each page is not a text layer, and a real page of text is", () => {
  assert.equal(
    hasTextLayer(textLayer(withText(["12", "Rev A", "14"]))),
    false,
    "a few characters a page is still a scan",
  );
  assert.equal(hasTextLayer(textLayer(withText(["x".repeat(49), "y".repeat(49)]))), false);
  assert.equal(
    hasTextLayer(textLayer(withText(["x".repeat(50), "y".repeat(50)]))),
    true,
    "fifty a page is the line",
  );
});

test("a conversion with no pages is not a PDF's, so there is nothing to draw and it counts as text", () => {
  assert.equal(hasTextLayer(textLayer("")), true);
  assert.equal(
    hasTextLayer(textLayer("# notes.docx\n\nSome prose with no page headings at all.")),
    true,
  );
});

test("the page reader has an id the spec schema accepts, and keys of its own beside the text reader's", () => {
  assert.match(
    VISION_EXTRACTOR_ID,
    /^(ai|table):[\w./@:-]+$/,
    "the same pattern schema/model.ts holds extractedBy to",
  );
  assert.notEqual(readerKey(VISION_EXTRACTOR_ID), readerKey(EXTRACTOR_ID));
  assert.equal(
    readerKey(VISION_EXTRACTOR_ID),
    "ai_cf_moonshotai_kimi-k2.7-code_vision-p3",
    "p2 read figures page by page, and a page does not always name what it rates (#28)",
  );
  assert.equal(
    PAGE_CONVERTER,
    "pages-kimi-k2.7-code-p3",
    "the transcription keeps its own version, so a new figures prompt draws no page again",
  );
  assert.equal(
    readerKey(EXTRACTOR_ID),
    EXTRACTOR_ID.replace(/[^\w.-]+/g, "_"),
    "the text reader's key is what it always was",
  );
});

test("the page reader must give every figure a unit, and the text reader's answer is unchanged", () => {
  const figure = (schema: typeof RESPONSE_SCHEMA) =>
    schema.properties.products.items.properties.specs.items;
  assert.deepEqual(figure(VISION_RESPONSE_SCHEMA).required, ["name", "value", "unit"]);
  assert.deepEqual(figure(RESPONSE_SCHEMA).required, ["name", "value"]);
});

/** Kinetic Solar's CSA certificate as the page reader wrote it down: the product on page 1, its ratings on page 2. */
const CERTIFICATE = transcriptDocument("CoFC_70214420_EN.pdf", [
  {
    page: 1,
    markdown:
      "# Certificate of Compliance\n\n**Model:** K-Rack\n\nKinetic K-Rack is an extruded aluminum PV racking system.\n\nDQD 507 Rev 2018-11-12 © 2018 CSA Group. Page 1",
  },
  {
    page: 2,
    markdown:
      "Mechanical ratings UL 2703:\n\n| Downward Design Load (lb/ft²) | 75.3 |\n| Upward Design Load (lb/ft²) | 33.4 |\n\n| DQD 507 Rev 2018-11-12 | Page 2 |",
  },
]);

test("a figure keeps the page its value is printed on, never one the model names", () => {
  const [window] = figureWindows(CERTIFICATE);
  assert.ok(window);
  const answer = JSON.stringify({
    products: [
      {
        model: "K-Rack",
        specs: [
          { name: "Downward Design Load", value: "75.3", unit: "lb/ft²", page: 9 },
          { name: "Uplift", value: "not printed anywhere", unit: "lb/ft²" },
        ],
      },
    ],
  });
  assert.deepEqual(reportsInWindow(answer, CERTIFICATE, window), [
    {
      model: "K-Rack",
      specs: [
        { name: "Downward Design Load", value: "75.3", unit: "lb/ft²", page: 2 },
        // Not found as printed, it gets no page: no page is better than a guessed one.
        { name: "Uplift", value: "not printed anywhere", unit: "lb/ft²" },
      ],
    },
  ]);
});

test("a value printed on two pages gets no page, and a short one is not found in a heading or a longer number", () => {
  const table = transcriptDocument("range.pdf", [
    {
      page: 1,
      markdown: "| Model | A-12 | A-24 |\n| Nominal voltage | 48 V | 48 V |\n| Units | 10 | 12 |",
    },
    { page: 2, markdown: "| Model | B-48 |\n| Nominal voltage | 48 V |\n| Parallel units | 1 |" },
  ]);
  const [window] = figureWindows(table);
  assert.ok(window);
  const answer = JSON.stringify({
    products: [
      {
        model: "B-48",
        specs: [
          { name: "Nominal voltage", value: "48 V", unit: "V" },
          { name: "Parallel units", value: "1", unit: "" },
        ],
      },
    ],
  });
  assert.deepEqual(reportsInWindow(answer, table, window)[0]?.specs, [
    // Printed on both pages: which one it came from cannot be told, so it gets none.
    { name: "Nominal voltage", value: "48 V", unit: "V" },
    // "1" is also in "### Page 1" and inside "10" and "12" on page 1, and a figure only on page 2.
    { name: "Parallel units", value: "1", unit: "", page: 2 },
  ]);
});

test("a value is not found inside a name the answer gives, whatever separates its parts", () => {
  const sheet = transcriptDocument("rm.pdf", [
    { page: 1, markdown: "**Model:** RM 12\n\n| Weight | 230 g |" },
    { page: 2, markdown: "| Rated current | 12 A |" },
  ]);
  const [window] = figureWindows(sheet);
  assert.ok(window);
  const answer = (value: string) =>
    JSON.stringify({
      products: [{ model: "RM 12", specs: [{ name: "Rated", value, unit: "" }] }],
    });
  assert.equal(
    reportsInWindow(answer("12"), sheet, window)[0]?.specs[0]?.page,
    2,
    "the 12 A on page 2, not the name on page 1",
  );
  const only = transcriptDocument("rm.pdf", [
    { page: 1, markdown: "**Model:**  RM\n12\n\n| Weight | 230 g |" },
  ]);
  const [alone] = figureWindows(only);
  assert.ok(alone);
  assert.equal(
    reportsInWindow(answer("12"), only, alone)[0]?.specs[0]?.page,
    undefined,
    "printed only as the name, even across a line break, it gets no page",
  );
});

test("a value on a row or label that names the product is part of the name, not a rating", () => {
  const sheet = transcriptDocument("family.pdf", [
    { page: 1, markdown: "| Family | RM |\n| Model | 12 |\n| Weight | 230 g |" },
    { page: 2, markdown: "## Model 24\n\n**Part number:** 24" },
    { page: 3, markdown: "| Rated voltage | 24 V |" },
  ]);
  const [window] = figureWindows(sheet);
  assert.ok(window);
  const answer = JSON.stringify({
    products: [
      {
        // The name the prompt asks for, put together from the Family and Model rows.
        model: "RM 12",
        specs: [
          { name: "Rated voltage", value: "12", unit: "V" },
          { name: "Weight", value: "230", unit: "g" },
        ],
      },
      { model: "RM 24", specs: [{ name: "Rated voltage", value: "24", unit: "V" }] },
    ],
  });
  const [first, second] = reportsInWindow(answer, sheet, window);
  assert.deepEqual(
    first?.specs.map((s) => s.page),
    [undefined, 1],
    "the 12 is only in the Model row, so no page; the weight is on its own row",
  );
  assert.equal(second?.specs[0]?.page, 3, "not the heading or the part number on page 2");
});

test("a figure two overlapping windows both report keeps the page whichever window found it", () => {
  const figure = { name: "Weight", value: "42", unit: "kg" };
  assert.deepEqual(
    mergeReports([
      { model: "S-550", specs: [figure] },
      { model: "S-550", specs: [{ ...figure, page: 3 }] },
    ]),
    [{ model: "S-550", specs: [{ ...figure, page: 3 }] }],
  );
  assert.deepEqual(
    mergeReports([
      { model: "S-550", specs: [{ ...figure, page: 2 }] },
      { model: "S-550", specs: [{ ...figure, page: 5 }] },
    ]),
    [{ model: "S-550", specs: [{ ...figure, page: 2 }] }],
    "a page already found is not replaced",
  );
});

test("a value is not found inside a model name, where a hyphen or a slash joins it to the rest", () => {
  const sheet = transcriptDocument("rm.pdf", [
    { page: 1, markdown: "**Model:** RM-12\n\n| Family | MultiPlus-II 48/3000/35-32 |" },
    { page: 2, markdown: "| Rated current | 12 A |\n| Input range | 12-24 V |" },
  ]);
  const [window] = figureWindows(sheet);
  assert.ok(window);
  const answer = JSON.stringify({
    products: [
      {
        model: "RM-12",
        specs: [
          { name: "Rated current", value: "12", unit: "A" },
          { name: "Rated power", value: "3000", unit: "VA" },
          { name: "Input range", value: "12-24", unit: "V" },
        ],
      },
    ],
  });
  assert.deepEqual(reportsInWindow(answer, sheet, window)[0]?.specs, [
    // Not "RM-12" on page 1, nor the start of "12-24": the "12 A" on page 2.
    { name: "Rated current", value: "12", unit: "A", page: 2 },
    // Printed only inside the model's name, so no page makes it look checkable.
    { name: "Rated power", value: "3000", unit: "VA" },
    { name: "Input range", value: "12-24", unit: "V", page: 2 },
  ]);
});

test("a window's answer with nothing in it is empty, a malformed product is dropped, and prose is a failed call", () => {
  const [window] = figureWindows(CERTIFICATE);
  assert.ok(window);
  assert.deepEqual(reportsInWindow(JSON.stringify({ products: [] }), CERTIFICATE, window), []);
  assert.deepEqual(reportsInWindow(JSON.stringify({}), CERTIFICATE, window), []);
  assert.deepEqual(
    reportsInWindow(
      JSON.stringify({
        products: [{ model: "A" }, { specs: [] }, null, { model: "B", specs: [] }],
      }),
      CERTIFICATE,
      window,
    ),
    [{ model: "B", specs: [] }],
  );
  assert.deepEqual(
    reportsInWindow(
      JSON.stringify({
        products: [
          {
            model: "K-Rack",
            specs: [null, "75.3", { name: "Downward Design Load", value: "75.3", unit: "lb/ft²" }],
          },
        ],
      }),
      CERTIFICATE,
      window,
    ),
    [
      {
        model: "K-Rack",
        specs: [{ name: "Downward Design Load", value: "75.3", unit: "lb/ft²", page: 2 }],
      },
    ],
    "a malformed figure is dropped and the rest of the window kept",
  );
  assert.throws(() => reportsInWindow("I could not read this.", CERTIFICATE, window), SyntaxError);
});

test("a short transcript is one window, and a long one several that overlap, each starting on its page", () => {
  assert.deepEqual(
    figureWindows(CERTIFICATE).map((w) => [w.start, w.page, w.text.length]),
    [[0, undefined, CERTIFICATE.length]],
    "the first window starts before page 1, on the title",
  );
  const long = transcriptDocument(
    "manual.pdf",
    Array.from({ length: 30 }, (_, i) => ({ page: i + 1, markdown: `${"x".repeat(2990)}` })),
  );
  const windows = figureWindows(long);
  assert.equal(windows.length, 3);
  assert.deepEqual(
    windows.map((w) => w.start),
    [0, FIGURE_WINDOW_CHARACTERS - 2_000, 2 * (FIGURE_WINDOW_CHARACTERS - 2_000)],
  );
  assert.ok(
    windows.slice(1).every((w) => (w.page ?? 0) > 1),
    "later windows start on later pages",
  );
  assert.deepEqual(figureWindows("   \n"), [], "nothing to read, no window");
});

test("a later window is sent with the start of the document, for the names printed there", () => {
  const long = transcriptDocument("manual.pdf", [
    { page: 1, markdown: "# MultiPlus-II 48/3000/35-32 230V\n\nOwner's manual" },
    ...Array.from({ length: 20 }, (_, i) => ({ page: i + 2, markdown: "y".repeat(2990) })),
  ]);
  const [first, second] = figureWindows(long);
  assert.ok(first && second);
  assert.ok(
    windowPrompt(long, first).startsWith("### Page 1\n\n# MultiPlus-II"),
    "the first window already holds it",
  );
  const prompt = windowPrompt(long, second);
  assert.ok(
    prompt.startsWith("The document begins:\n\n### Page 1\n\n# MultiPlus-II 48/3000/35-32 230V"),
    "the name on page 1 comes with it",
  );
  assert.ok(prompt.endsWith(second.text), "and then the window itself");
});

test("the model is never shown the file's name or the metadata, which the document does not print", () => {
  // A scan saved under a product's name, whose pages never print it.
  const sheet = transcriptDocument("RM-12-spec-sheet.pdf", [
    { page: 1, markdown: "| Weight | 230 g |" },
    { page: 2, markdown: "", failed: "not transcribed: 3040: capacity temporarily exceeded" },
    ...Array.from({ length: 20 }, (_, i) => ({ page: i + 3, markdown: "y".repeat(2990) })),
  ]);
  assert.match(sheet, /^# RM-12-spec-sheet\.pdf\n## Metadata\n/);
  const [first, second] = figureWindows(sheet);
  assert.ok(first && second);
  for (const prompt of [windowPrompt(sheet, first), windowPrompt(sheet, second)]) {
    assert.ok(!prompt.includes("RM-12"), "no name the pages do not print");
    assert.ok(!prompt.includes("## Metadata") && !prompt.includes("Not transcribed"));
  }
});

test("a transcription comes out of its answer whole, with only a fence around the answer taken off", () => {
  assert.equal(
    transcriptOf(JSON.stringify({ markdown: "| Weight | 42 lbs |" })),
    "| Weight | 42 lbs |",
  );
  assert.equal(
    transcriptOf(`\`\`\`json\n${JSON.stringify({ markdown: "| Weight | 42 lbs |" })}\n\`\`\``),
    "| Weight | 42 lbs |",
  );
  const fencedInside = "Wiring:\n```\nRS485 A+ B-\n```\n| Baud rate | 9600 |";
  assert.equal(
    transcriptOf(JSON.stringify({ markdown: fencedInside })),
    fencedInside,
    "a fence on the page is part of the page",
  );
  assert.equal(transcriptOf(JSON.stringify({ markdown: "" })), "", "a blank page is an answer");
});

test("a transcription answer without its markdown, or not JSON at all, is a failed call", () => {
  assert.throws(() => transcriptOf(JSON.stringify({ products: [] })), /without its markdown/);
  assert.throws(
    () => transcriptOf("The user wants me to transcribe the page.</think>| Weight | 42 lbs |"),
    SyntaxError,
    "a model thinking aloud into its answer",
  );
});

test("the pages put together read as a conversion, and a page's own 'Page 43' cannot split it", () => {
  const document = transcriptDocument("48513.pdf", [
    {
      page: 1,
      markdown:
        '# MODEL 2548 SPECIFICATIONS\n\n| Weight | 42 lbs. |\n| Dimensions | Height 9.75", width 11.5", depth 13.5" |\n\n### Page 43',
    },
    { page: 2, markdown: "[performance chart]\n\n## Page 44" },
  ]);
  assert.deepEqual(
    pageOffsets(document).map((p) => p.page),
    [1, 2],
    "the printed footers stay text",
  );
  assert.ok(
    document.includes("\nPage 43\n") && document.includes("\nPage 44\n"),
    "and are still there, as printed",
  );
  assert.equal(
    withoutPageHeadings("## Specifications\n#### Page 7\nPage 8 of 9"),
    "## Specifications\nPage 7\nPage 8 of 9",
  );
  // What reading it again takes: the text reader's windows, each with the page it starts on.
  assert.equal(
    hasTextLayer(textLayer(document)),
    true,
    "it has a text layer now, so it is not a scan to draw again",
  );
  assert.ok(
    chunk(document, 80, 0).some((w) => w.page === 2),
    "a window that starts on page two says so",
  );
  assert.equal(
    transcriptDocument("empty.pdf", []),
    `# empty.pdf\n## Metadata\n- Converter=${PAGE_CONVERTER}\n\n## Contents\n`,
  );
});

test("a page that could not be written down is named in the transcript, not left looking blank", () => {
  const document = transcriptDocument("cert.pdf", [
    { page: 1, markdown: "", failed: "not transcribed: 3040: capacity temporarily exceeded" },
    { page: 2, markdown: "| Rated power | 2400 W |" },
    { page: 3, markdown: "", failed: "not drawn: PDFium could not open it" },
  ]);
  assert.ok(document.includes("\n- Not transcribed=1, 3\n"));
  assert.deepEqual(notTranscribed(document), [1, 3]);
  assert.deepEqual(notTranscribed(CERTIFICATE), [], "a transcript with every page says nothing");
});

// ---- the steps, against an archive in memory and a model that answers what it is told ----

const SHA = "a".repeat(64);
const URL_ = "https://maker.test/sheet.pdf";
const ids = {
  run: "2026-09-10-abcd1234",
  manufacturer: "maker",
  date: "2026-09-10",
  sha256: SHA,
  url: URL_,
};
const READER = readerKey(VISION_EXTRACTOR_ID);

const markdownKey = partKey.markdown(SHA, CONVERTER);
const readingKey = partKey.reading(SHA, READER);
const transcriptKey = partKey.markdown(SHA, PAGE_CONVERTER);
const pageKey = (page: number) => partKey.page(SHA, PAGE_CONVERTER, page);
const windowKey = (window: number) => partKey.window(SHA, READER, window);

test("a scan is sent on one page at a time, each message saying how many pages the reading waits for", async () => {
  const { env, sent } = world({
    [markdownKey]: withText(["", "", ""]),
    [`archive/${SHA}`]: tinyPdf(["", "", ""]),
  });
  await seeDocument({ kind: "vision", ...ids }, env);
  assert.deepEqual(
    sent,
    [1, 2, 3].map((page) => ({ kind: "vision-page", ...ids, page, pages: 3 })),
  );
});

test("a document with a text layer, or none to draw, or a reading already, sends nothing", async () => {
  for (const [why, objects] of [
    [
      "it has text",
      {
        [markdownKey]: withText([
          "| Nominal voltage | 48 V |\n| Rated capacity | 100 Ah at C/5, 25 °C |\n| Weight | 42 kg |\n| Dimensions | 442 × 410 × 133 mm |",
        ]),
        [`archive/${SHA}`]: tinyPdf([""]),
      },
    ],
    [
      "the converter made nothing of it, like a ZIP of logos",
      { [`archive/${SHA}`]: new TextEncoder().encode("PK") },
    ],
    [
      "it has been read",
      { [markdownKey]: SCANNED, [`archive/${SHA}`]: tinyPdf([""]), [readingKey]: "{}" },
    ],
  ] as const) {
    const { env, sent } = world(objects);
    await seeDocument({ kind: "vision", ...ids }, env);
    assert.deepEqual(sent, [], `nothing, because ${why}`);
  }
});

test("a document written down before goes straight to its figures, and no page is drawn again", async () => {
  const { env, sent } = world({
    [markdownKey]: SCANNED,
    [`archive/${SHA}`]: tinyPdf([""]),
    [transcriptKey]: CERTIFICATE,
  });
  await seeDocument({ kind: "vision", ...ids }, env);
  assert.deepEqual(sent, [{ kind: "vision-window", ...ids, window: 1, windows: 1 }]);
});

test("a document too big to draw is refused in writing, where its reading would be", async () => {
  const { env, sent, readObject } = world({
    [markdownKey]: SCANNED,
    [`archive/${SHA}`]: new Uint8Array(MAX_RENDER_BYTES + 1),
  });
  await seeDocument({ kind: "vision", ...ids }, env);
  assert.deepEqual(sent, []);
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual(reading.products, []);
  assert.equal(reading.extractedBy, VISION_EXTRACTOR_ID);
  assert.match(reading.refused, /^16\.0 MB, over the 16 MB/);
});

test("a scan longer than the budget is read up to the budget", async () => {
  const { env, sent } = world({
    [markdownKey]: withText(Array.from({ length: MAX_PAGES + 5 }, () => "")),
    [`archive/${SHA}`]: tinyPdf([""]),
  });
  await seeDocument({ kind: "vision", ...ids }, env);
  assert.equal(sent.length, MAX_PAGES);
  assert.ok(sent.every((m) => m.kind === "vision-page" && m.pages === MAX_PAGES));
});

test("a document the converter made markdown of but the archive has lost is an error to retry, not a quiet skip", async () => {
  const { env } = world({ [markdownKey]: SCANNED });
  await assert.rejects(seeDocument({ kind: "vision", ...ids }, env), /is not in the archive/);
});

const answer = (body: unknown) => ({ choices: [{ message: { content: JSON.stringify(body) } }] });

/**
 * A model that writes each drawn page down as the next of `transcripts` says (an Error fails that
 * call), and reads figures out of what it is given as `read` says. The two calls are told apart by
 * the schema each asks for.
 */
function kimi(
  transcripts: (string | Error)[],
  read: (text: string) => unknown = () => answer({ products: [] }),
) {
  let drawn = 0;
  return (_call: number, input: TestAiInput): unknown => {
    if (input.response_format.json_schema.name !== "page") {
      const content = input.messages[1].content;
      assert.equal(typeof content, "string");
      return read(content as string);
    }
    const transcript = transcripts[drawn++];
    return transcript instanceof Error ? transcript : answer({ markdown: transcript });
  };
}

test("each page is written down, and the last to land puts the transcript together and sends its windows", async () => {
  const { env, asked, sent, readObject, text } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX, BLACK_BOX]) },
    kimi(["**Model:** K-Rack", "| Downward Design Load (lb/ft²) | 75.3 |"]),
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 2 }, env, 1, pdfium);
  assert.equal(text(transcriptKey), undefined, "one page of two is not a transcript");
  assert.deepEqual(readObject<SeenPage>(pageKey(1)), { page: 1, markdown: "**Model:** K-Rack" });
  assert.deepEqual(sent, []);

  await seePage({ kind: "vision-page", ...ids, page: 2, pages: 2 }, env, 1, pdfium);
  const transcript = text(transcriptKey);
  assert.ok(transcript);
  assert.ok(
    transcript.startsWith(`# sheet.pdf\n## Metadata\n- Converter=${PAGE_CONVERTER}\n`),
    "named like a conversion, and saying which",
  );
  assert.ok(
    transcript.includes("### Page 1\n\n**Model:** K-Rack\n") &&
      transcript.includes("### Page 2\n\n| Downward Design Load (lb/ft²) | 75.3 |\n"),
  );
  assert.deepEqual(sent, [{ kind: "vision-window", ...ids, window: 1, windows: 1 }]);
  assert.equal(text(readingKey), undefined, "the reading waits for its windows");

  // What the model was shown for each page: the drawn page, as a PNG, and nothing else asked.
  assert.equal(asked.length, 2, "one call a page, to write it down");
  assert.ok(asked.every((a) => a.model === VISION_MODEL));
  const imageContent = asked[0].input.messages[1].content;
  assert.ok(Array.isArray(imageContent));
  const imageUrl = imageContent[1]?.image_url?.url;
  assert.ok(imageUrl?.startsWith("data:image/png;base64,iVBORw0KGgo"), "a PNG, by its first bytes");
  assert.deepEqual(asked[0].input.response_format.json_schema.schema, TRANSCRIPT_SCHEMA);
  assert.ok(
    asked.every((a) => a.input.chat_template_kwargs.thinking === false),
    "Kimi's own name for the switch; it ignores enable_thinking",
  );
});

test("a window is read with the names the whole document prints, and the last one writes the reading", async () => {
  const seen: string[] = [];
  const { env, asked, readObject } = world(
    { [transcriptKey]: CERTIFICATE },
    kimi([], (text) => {
      seen.push(text);
      return answer({
        products: [
          {
            model: "K-Rack",
            specs: [
              { name: "Downward Design Load", value: "75.3", unit: "lb/ft²" },
              { name: "Upward Design Load", value: "33.4", unit: "lb/ft²" },
            ],
          },
        ],
      });
    }),
  );
  await seeWindow({ kind: "vision-window", ...ids, window: 1, windows: 1 }, env, 1);
  assert.deepEqual(
    seen,
    [CERTIFICATE.slice(CERTIFICATE.indexOf("### Page 1"))],
    "page 1's name and page 2's ratings in one read, under no title but what the pages print",
  );
  assert.equal(asked[0].input.messages[0].content, DOCUMENT_FIGURES_SYSTEM);
  assert.deepEqual(asked[0].input.response_format.json_schema.schema, VISION_RESPONSE_SCHEMA);
  const reading = readObject<Reading & { windows: number }>(readingKey);
  assert.deepEqual(reading.products, [
    {
      model: "K-Rack",
      specs: [
        { name: "Downward Design Load", value: "75.3", unit: "lb/ft²", page: 2 },
        { name: "Upward Design Load", value: "33.4", unit: "lb/ft²", page: 2 },
      ],
    },
  ]);
  assert.deepEqual(
    [reading.pages, reading.failed, reading.windows, reading.transcript, reading.extractedBy],
    [2, 0, 1, transcriptKey, VISION_EXTRACTOR_ID],
  );
});

test("a window whose answer runs out of room is read again as two halves, each its own turn", async () => {
  // A dense sheet: one call cannot write every figure out, each half can.
  const dense = transcriptDocument("dense.pdf", [
    { page: 1, markdown: `| Weight | 230 g |\n| Voltage | 48 V |\n\n${"a".repeat(6000)}` },
    { page: 2, markdown: `| Rated current | 12 A |\n| Voltage | 48 V |\n\n${"b".repeat(6000)}` },
  ]);
  const seen: string[] = [];
  const { env, pace, readObject } = world(
    { [transcriptKey]: dense },
    kimi([], (text) => {
      seen.push(text);
      if (seen.length === 1) return { response: '{"products":[{"model":"RM-12","specs":[{"na' };
      const specs = [
        ...(text.includes("230 g") ? [{ name: "Weight", value: "230", unit: "g" }] : []),
        ...(text.includes("12 A") ? [{ name: "Rated current", value: "12", unit: "A" }] : []),
        { name: "Voltage", value: "48", unit: "V" },
      ];
      return answer({ products: [{ model: "RM-12", specs }] });
    }),
  );
  await seeWindow(windowOne, env, 1);
  assert.equal(seen.length, 3, "the whole window, then its two halves");
  assert.equal(pace.asked, 3, "and each call took its turn with the model");
  assert.deepEqual(readObject<Reading>(readingKey).products, [
    {
      model: "RM-12",
      specs: [
        { name: "Weight", value: "230", unit: "g", page: 1 },
        { name: "Rated current", value: "12", unit: "A", page: 2 },
        // A half could see one "48 V" and name its page; the whole window prints it on two.
        { name: "Voltage", value: "48", unit: "V" },
      ],
    },
  ]);
});

test("a small window whose answer is cut short is a failed call, not halved", async () => {
  const { env, asked, readObject } = world(
    { [transcriptKey]: CERTIFICATE },
    kimi([], () => ({ response: '{"products":[{"model":"K-Rack"' })),
  );
  await seeWindow(windowOne, env, LAST_ATTEMPT);
  assert.equal(asked.length, 1);
  assert.match(readObject<ReadWindow>(windowKey(1)).failed ?? "", /^not read: .*JSON/);
});

test("a value printed only as the document's own page number gets no page", () => {
  const sheet = transcriptDocument("footer.pdf", [
    { page: 1, markdown: "| Weight | 230 g |\n\nPage 2 of 4" },
    { page: 2, markdown: "| Output | 1 kW |\n\n| DQD 507 | Page 3 |" },
  ]);
  const [window] = figureWindows(sheet);
  assert.ok(window);
  const answer = JSON.stringify({
    products: [
      {
        model: "RM-12",
        specs: [
          { name: "Cells", value: "2", unit: "" },
          { name: "Strings", value: "3", unit: "" },
        ],
      },
    ],
  });
  assert.deepEqual(
    reportsInWindow(answer, sheet, window)[0]?.specs.map((s) => s.page),
    [undefined, undefined],
    "neither a footer's own line nor one inside a table row",
  );
});

test("a reading waits for every window, and a window delivered twice is read once", async () => {
  const long = transcriptDocument(
    "manual.pdf",
    Array.from({ length: 20 }, (_, i) => ({ page: i + 1, markdown: "z".repeat(2990) })),
  );
  const { env, asked, read } = world({ [transcriptKey]: long }, kimi([]));
  const windows = figureWindows(long).length;
  assert.equal(windows, 2);
  await seeWindow({ kind: "vision-window", ...ids, window: 1, windows }, env, 1);
  await seeWindow({ kind: "vision-window", ...ids, window: 1, windows }, env, 1);
  assert.equal(asked.length, 1, "the second delivery asks nothing");
  assert.equal(read(readingKey), undefined, "one window of two is not a reading");
  await seeWindow({ kind: "vision-window", ...ids, window: 2, windows }, env, 1);
  assert.equal((read(readingKey) as { windows: number }).windows, 2);
  await seeWindow({ kind: "vision-window", ...ids, window: 2, windows }, env, 1);
  assert.equal(asked.length, 2, "and a finished reading stops a straggler from asking again");
});

test("a remark in place of a figure is refused, so a window whose answer was commentary holds nothing", async () => {
  // What GLM once gave an RM-12 sheet: one figure, wrapped in a note about a misprinted character.
  const remark = [
    {
      model: "RM-12",
      specs: [
        {
          name: "Power consumption",
          unit: "mA",
          value: "&20 (as printed; likely ≤20mA but printed as &20mA)",
        },
      ],
    },
  ];
  const { env, readObject } = world(
    { [transcriptKey]: CERTIFICATE },
    kimi([], () => answer({ products: remark })),
  );
  await seeWindow({ kind: "vision-window", ...ids, window: 1, windows: 1 }, env, 1);
  assert.equal(
    readObject<ReadWindow>(windowKey(1)).products[0].specs.length,
    1,
    "the window keeps what the model said",
  );
  assert.deepEqual(
    readObject<Reading>(readingKey).products,
    [],
    "and the reading does not publish it",
  );
});

test("a page or window that fails is retried by the queue, and on the last attempt written down", async () => {
  const capacity = new Error("3040: capacity temporarily exceeded");
  const page = world({ [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) }, () => capacity);
  await assert.rejects(
    seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, page.env, 1, pdfium),
    /capacity/,
    "thrown, so the queue delivers it again",
  );
  assert.equal(
    page.read(pageKey(1)),
    undefined,
    "and nothing is written that would stop the retry",
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, page.env, LAST_ATTEMPT, pdfium);
  assert.deepEqual(page.readObject<SeenPage>(pageKey(1)), {
    page: 1,
    markdown: "",
    failed: "not transcribed: 3040: capacity temporarily exceeded",
  });
  const reading = page.readObject<Reading>(readingKey);
  assert.deepEqual(
    [reading.products, reading.failed],
    [[], 1],
    "a transcript with nothing written down is read as nothing, without asking",
  );
  assert.equal(page.asked.length, 2, "one transcription on each attempt, and no read of nothing");

  const window = world({ [transcriptKey]: CERTIFICATE }, () => capacity);
  const one = { kind: "vision-window" as const, ...ids, window: 1, windows: 1 };
  await assert.rejects(seeWindow(one, window.env, 1), /capacity/);
  await seeWindow(one, window.env, LAST_ATTEMPT);
  assert.equal(
    window.readObject<ReadWindow>(windowKey(1)).failed,
    "not read: 3040: capacity temporarily exceeded",
  );
  assert.equal(window.readObject<Reading>(readingKey).failed, 1, "and the reading still finishes");
});

test("a page PDFium cannot draw is written down at once, without asking a model anything", async () => {
  const { env, asked, readObject } = world({
    [`archive/${SHA}`]: new TextEncoder().encode("%PDF-1.4 and then nothing"),
  });
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium);
  assert.equal(asked.length, 0);
  assert.match(readObject<SeenPage>(pageKey(1)).failed, /^not drawn: PDFium could not open it/);
  assert.equal(readObject<Reading>(readingKey).failed, 1);
});

// ---- waiting a turn with the model ----

const RATE_LIMITED = "3021: rate limiting: inference request per min rate reached";
const pageOne = { kind: "vision-page" as const, ...ids, page: 1, pages: 1 };
const windowOne = { kind: "vision-window" as const, ...ids, window: 1, windows: 1 };

test("a send of the windows that fails leaves no transcript, so the page delivered again sends them", async () => {
  // Written first, the transcript stopped every later page, and the windows were never sent.
  const { env, sent, text } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    kimi(["| Weight | 230 g |", "| Weight | 230 g |"]),
  );
  const sendBatch = env.WORK.sendBatch.bind(env.WORK);
  let refused = false;
  Object.assign(env.WORK, {
    sendBatch: async (batch: { body: Work }[]) => {
      if (!refused) {
        refused = true;
        throw new Error("Queue sendBatch failed: internal error");
      }
      return sendBatch(batch as never);
    },
  });
  await assert.rejects(seePage(pageOne, env, 1, pdfium), /internal error/);
  assert.equal(text(transcriptKey), undefined, "no transcript to stop the next delivery");
  await seePage(pageOne, env, 2, pdfium);
  assert.deepEqual(sent, [windowOne]);
  assert.ok(text(transcriptKey), "and the transcript is written after them");
});

test("a reading of nothing that fails to be written leaves no transcript, so the page delivered again writes it", async () => {
  const { env, sent, text } = world({ [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) }, kimi(["", ""]));
  const put = env.ARCHIVE.put.bind(env.ARCHIVE);
  let refused = false;
  Object.assign(env.ARCHIVE, {
    put: async (key: string, ...rest: unknown[]) => {
      if (key === readingKey && !refused) {
        refused = true;
        throw new Error("put: We encountered an internal error. Please try again. (10001)");
      }
      return put(key, ...(rest as [never, never]));
    },
  });
  await assert.rejects(seePage(pageOne, env, 1, pdfium), /internal error/);
  assert.equal(text(transcriptKey), undefined, "no transcript to stop the next delivery");
  await seePage(pageOne, env, 2, pdfium);
  assert.deepEqual(sent, [], "a blank page has no window to read");
  assert.ok(text(readingKey), "the reading is written");
  assert.ok(text(transcriptKey), "and the transcript after it");
});

test("a window that comes in before its transcript is written waits, without taking a turn", async () => {
  const { env, sent, asked, pace } = world({}, kimi([]));
  await seeWindow(windowOne, env, LAST_ATTEMPT);
  assert.equal(asked.length, 0);
  assert.equal(pace.asked, 0, "no turn with the model is used up");
  assert.deepEqual(sent, [{ ...windowOne, waits: 1 }]);
});

test("a page or window the pace turns away waits its turn: nothing is drawn or asked, and a copy comes back later", async () => {
  const page = world({ [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) }, kimi(["| Weight | 230 g |"]));
  page.pace.allow = () => false;
  await seePage(pageOne, page.env, 1, pdfium);
  assert.equal(page.asked.length, 0, "the model is not asked");
  assert.equal(page.read(pageKey(1)), undefined, "and nothing is written down");
  assert.deepEqual(page.sent, [{ ...pageOne, waits: 1 }]);
  assert.deepEqual(page.delays, [71], "a minute, and eleven seconds for this page's place");

  const window = world({ [transcriptKey]: CERTIFICATE }, kimi([]));
  window.pace.allow = () => false;
  await seeWindow(windowOne, window.env, 1);
  assert.equal(window.asked.length, 0);
  assert.deepEqual(window.sent, [{ ...windowOne, waits: 1 }]);
});

test("a page or window the model refuses on its rate limit waits too, even on its last delivery", async () => {
  const page = world({ [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) }, kimi([new Error(RATE_LIMITED)]));
  await seePage(pageOne, page.env, LAST_ATTEMPT, pdfium);
  assert.equal(page.read(pageKey(1)), undefined, "not written as failed");
  assert.equal(page.read(transcriptKey), undefined, "so the transcript waits for it");
  assert.deepEqual(page.sent, [{ ...pageOne, waits: 1 }]);

  const window = world(
    { [transcriptKey]: CERTIFICATE },
    kimi([], () => new Error(RATE_LIMITED)),
  );
  await seeWindow({ ...windowOne, waits: 3 }, window.env, LAST_ATTEMPT);
  assert.equal(window.read(windowKey(1)), undefined);
  assert.deepEqual(window.sent, [{ ...windowOne, waits: 4 }]);
  assert.deepEqual(window.delays, [491], "eight minutes after three waits, and its eleven seconds");
});

test("the wait doubles from a minute to half an hour, and a page's or window's place spreads them", () => {
  // The spread is this document's first four hex digits plus the place, counted round a minute:
  // 0xaaaa is 43690, and 43691 is 11 past a multiple of sixty.
  const at = (page: number, waits?: number) =>
    waitFor({ ...pageOne, page, pages: 60, ...(waits === undefined ? {} : { waits }) });
  assert.deepEqual(
    [at(1), at(1, 1), at(1, 2), at(1, 4), at(1, 5), at(1, MAX_WAITS - 1)],
    [71, 131, 251, 971, 1811, 1811],
  );
  assert.deepEqual([at(2), at(49), at(50)], [72, 119, 60], "the place wraps round the minute");
  assert.equal(
    waitFor({ ...windowOne, window: 3, windows: 5 }),
    73,
    "a window's place is its number",
  );
});

test("past its last wait a refused page is a failure like any other, written down on its last delivery", async () => {
  const { env, sent, pace, readObject } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    kimi([new Error(RATE_LIMITED), new Error(RATE_LIMITED)]),
  );
  pace.allow = () => false;
  const last = { ...pageOne, waits: MAX_WAITS };
  await assert.rejects(seePage(last, env, 1, pdfium), /3021/, "the queue tries it again");
  await seePage(last, env, LAST_ATTEMPT, pdfium);
  assert.equal(pace.asked, 0, "the pace is not asked for a page that has waited its last");
  assert.equal(readObject<SeenPage>(pageKey(1)).failed, `not transcribed: ${RATE_LIMITED}`);
  assert.equal(readObject<Reading>(readingKey).failed, 1);
  assert.deepEqual(sent, [], "and it is not put back again");
});

// ---- offering a maker's run ----

const RUN = "documents/maker/runs/2026-09-10-abcd1234";
const pointer = JSON.stringify({
  run: "2026-09-10-abcd1234",
  date: "2026-09-10",
  startedAt: "2026-09-10T00:00:00Z",
});
const doc = (c: string) => ({
  sha256: c.repeat(64),
  url: `https://maker.test/${c}.pdf`,
  contentType: "application/pdf",
});

test("a run offers the documents that have converted, and writes down how many had", async () => {
  const { env, sent, readObject } = world({
    "documents/maker/current.json": pointer,
    [`${RUN}/converting.json`]: JSON.stringify({ documents: [doc("b"), doc("c"), doc("d")] }),
    [`${RUN}/converted/${"b".repeat(64)}.json`]: "{}",
    [`${RUN}/converted/${"d".repeat(64)}.json`]: "{}",
  });
  assert.deepEqual(await visionRun(env, "maker", "2026-09-10"), { documents: 2 });
  assert.deepEqual(
    sent.map((m) => m.kind === "vision" && m.sha256[0]),
    ["b", "d"],
    "c is still converting, and will be offered on a later pass",
  );
  assert.deepEqual(
    [
      readObject<{ converted: number; extractedBy: string }>(`${RUN}/seeing.json`).converted,
      readObject<{ converted: number; extractedBy: string }>(`${RUN}/seeing.json`).extractedBy,
    ],
    [2, VISION_EXTRACTOR_ID],
  );
});

test("a run with nothing converted offers nothing, and one never sent to conversion is an error", async () => {
  const empty = world({
    "documents/maker/current.json": pointer,
    [`${RUN}/converting.json`]: JSON.stringify({ documents: [doc("b")] }),
  });
  assert.deepEqual(await visionRun(empty.env, "maker", "2026-09-10"), { documents: 0 });
  assert.equal(
    empty.readObject<{ converted: number; extractedBy: string }>(`${RUN}/seeing.json`).converted,
    0,
  );
  await assert.rejects(
    visionRun(world({ "documents/maker/current.json": pointer }).env, "maker", "2026-09-10"),
    /nothing has been sent to conversion/,
  );
  await assert.rejects(visionRun(world().env, "maker", "2026-09-10"), /no current run/);
});

test("a run offered already, with nothing converted since, is not offered again", async () => {
  // The workflow offers makers from one look at the state; a pass may have offered one since.
  const { env, sent, store } = world({
    "documents/maker/current.json": pointer,
    [`${RUN}/converting.json`]: JSON.stringify({ documents: [doc("b"), doc("c")] }),
    [`${RUN}/converted/${"b".repeat(64)}.json`]: "{}",
  });
  assert.deepEqual(await visionRun(env, "maker", "2026-09-10"), { documents: 1 });
  assert.deepEqual(await visionRun(env, "maker", "2026-09-10"), { documents: 0 });
  assert.equal(sent.length, 1, "the second offer sends nothing");

  // A document converted since reopens the run.
  store.set(`${RUN}/converted/${"c".repeat(64)}.json`, new TextEncoder().encode("{}"));
  assert.deepEqual(await visionRun(env, "maker", "2026-09-10"), { documents: 2 });

  // And an offer made to an earlier page reader does not count as one to this reader.
  store.set(
    `${RUN}/seeing.json`,
    new TextEncoder().encode(JSON.stringify({ converted: 2, extractedBy: "ai:older@vision-p0" })),
  );
  assert.deepEqual(await visionRun(env, "maker", "2026-09-10"), { documents: 2 });
});

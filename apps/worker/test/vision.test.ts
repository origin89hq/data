import type { Reported } from "../src/reading.ts";
import type { SeenPage } from "../src/vision.ts";

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
  EXTRACTOR_ID,
  hasTextLayer,
  MAX_PAGES,
  MAX_RENDER_BYTES,
  PAGE_CONVERTER,
  pageOffsets,
  RESPONSE_SCHEMA,
  reportsOnPage,
  TRANSCRIPT_SCHEMA,
  textLayer,
  transcriptDocument,
  transcriptOf,
  VISION_EXTRACTOR_ID,
  VISION_MODEL,
  VISION_RESPONSE_SCHEMA,
  withoutPageHeadings,
} from "../src/reading.ts";
import { seeDocument, seePage } from "../src/vision.ts";
import { LAST_ATTEMPT, partKey, readerKey } from "../src/work.ts";
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

test("the page reader has an id the spec schema accepts, and a key of its own beside the text reader's", () => {
  assert.match(
    VISION_EXTRACTOR_ID,
    /^(ai|table):[\w./@:-]+$/,
    "the same pattern schema/model.ts holds extractedBy to",
  );
  assert.notEqual(readerKey(VISION_EXTRACTOR_ID), readerKey(EXTRACTOR_ID));
  assert.equal(readerKey(VISION_EXTRACTOR_ID), "ai_cf_moonshotai_kimi-k2.7-code_vision-p1");
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

test("a page's answer carries the page it was drawn from, whatever page the model thought it was", () => {
  const answer = JSON.stringify({
    products: [
      { model: "UGP-24CR", specs: [{ name: "Weight", value: "156.5", unit: "lb", page: 9 }] },
    ],
  });
  assert.deepEqual(reportsOnPage(answer, 1), [
    { model: "UGP-24CR", specs: [{ name: "Weight", value: "156.5", unit: "lb", page: 1 }] },
  ]);
});

test("a page with nothing on it is an empty answer, and a malformed product is dropped", () => {
  assert.deepEqual(reportsOnPage(JSON.stringify({ products: [] }), 3), []);
  assert.deepEqual(reportsOnPage(JSON.stringify({}), 3), []);
  assert.deepEqual(
    reportsOnPage(
      JSON.stringify({
        products: [{ model: "A" }, { specs: [] }, null, { model: "B", specs: [] }],
      }),
      3,
    ),
    [{ model: "B", specs: [] }],
  );
});

test("an answer that is not JSON is a failed call, not a page with nothing on it", () => {
  assert.throws(() => reportsOnPage("I could not read this page.", 1), SyntaxError);
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

// ---- the two steps, against an archive in memory and a model that answers what it is told ----

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
const transcriptKey = partKey.markdown(SHA, PAGE_CONVERTER);

/**
 * A model that writes each drawn page down as the next of `transcripts` says (an Error fails that
 * call), and reads figures out of a transcript as `read` says. The two calls are told apart by the
 * schema each asks for.
 */
function kimi(
  transcripts: (string | Error)[],
  read: (markdown: string) => unknown = () => answer({ products: [] }),
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

test("each page is written down and then read, and the last to land puts the transcription and the reading together", async () => {
  const { env, asked, read, readObject, text } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX, BLACK_BOX]) },
    kimi(["| Weight | 230 g |", "| Baud rate | 9600 bps |"], (markdown) =>
      answer({
        products: [
          {
            model: "RM-12",
            specs: markdown.includes("Weight")
              ? [{ name: "Weight", value: "230", unit: "g" }]
              : [{ name: "Baud rate", value: "9600", unit: "bps" }],
          },
        ],
      }),
    ),
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 2 }, env, 1, pdfium);
  assert.equal(read(readingKey), undefined, "one page of two is not a reading");
  assert.equal(text(transcriptKey), undefined, "nor a transcription");
  assert.deepEqual(readObject<SeenPage>(partKey.page(SHA, READER, 1)), {
    page: 1,
    markdown: "| Weight | 230 g |",
    products: [{ model: "RM-12", specs: [{ name: "Weight", value: "230", unit: "g", page: 1 }] }],
  });

  await seePage({ kind: "vision-page", ...ids, page: 2, pages: 2 }, env, 1, pdfium);
  const transcript = text(transcriptKey);
  assert.ok(transcript);
  assert.ok(
    transcript.startsWith(`# sheet.pdf\n## Metadata\n- Converter=${PAGE_CONVERTER}\n`),
    "named like a conversion, and saying which",
  );
  assert.ok(
    transcript.includes("### Page 1\n\n| Weight | 230 g |\n") &&
      transcript.includes("### Page 2\n\n| Baud rate | 9600 bps |\n"),
  );
  const reading = readObject<Reading>(readingKey);
  assert.deepEqual(reading.products, [
    {
      model: "RM-12",
      specs: [
        { name: "Weight", value: "230", unit: "g", page: 1 },
        { name: "Baud rate", value: "9600", unit: "bps", page: 2 },
      ],
    },
  ]);
  assert.deepEqual(
    [reading.pages, reading.failed, reading.transcript, reading.extractedBy, reading.url],
    [2, 0, transcriptKey, VISION_EXTRACTOR_ID, URL_],
  );

  // What the model was shown: the drawn page, as a PNG, for the transcription; then only the
  // transcription, with a schema that will not take a figure without a unit.
  assert.equal(asked.length, 4, "two calls a page");
  assert.ok(asked.every((a) => a.model === VISION_MODEL));
  const imageContent = asked[0].input.messages[1].content;
  assert.ok(Array.isArray(imageContent));
  const imageUrl = imageContent[1]?.image_url?.url;
  assert.ok(imageUrl?.startsWith("data:image/png;base64,iVBORw0KGgo"), "a PNG, by its first bytes");
  assert.deepEqual(asked[0].input.response_format.json_schema.schema, TRANSCRIPT_SCHEMA);
  assert.equal(
    asked[1].input.messages[1].content,
    "| Weight | 230 g |",
    "the figures are read from the words, not the picture",
  );
  assert.deepEqual(
    (asked[1].input.response_format.json_schema.schema as typeof VISION_RESPONSE_SCHEMA).properties
      .products.items.properties.specs.items.required,
    ["name", "value", "unit"],
  );
  assert.ok(
    asked.every((a) => a.input.chat_template_kwargs.thinking === false),
    "Kimi's own name for the switch; it ignores enable_thinking",
  );
});

test("a page with no digit on it is written down and not read for figures, which it cannot hold", async () => {
  const { env, asked, readObject, text } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    kimi(["[illustration of a vertical turbine pump]"]),
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium);
  assert.equal(asked.length, 1, "the transcription, and no second call");
  assert.deepEqual(readObject<Reading>(readingKey).products, []);
  assert.ok(
    text(transcriptKey)?.includes("### Page 1\n\n[illustration of a vertical turbine pump]\n"),
  );
});

test("a page delivered twice is read once, and a finished reading stops a straggler from asking again", async () => {
  const { env, asked, readObject } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    kimi(["| Weight | 230 g |"], () =>
      answer({
        products: [{ model: "RM-12", specs: [{ name: "Weight", value: "230", unit: "g" }] }],
      }),
    ),
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium);
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium);
  assert.equal(asked.length, 2, "the first delivery's two calls, and none for the second");
  assert.equal(readObject<Reading>(readingKey).products.length, 1);
});

test("a remark in place of a figure is refused, so a page whose answer was commentary holds nothing", async () => {
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
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    kimi(["| Power consumption | &20mA |"], () => answer({ products: remark })),
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium);
  assert.equal(
    readObject<SeenPage>(partKey.page(SHA, READER, 1)).products[0].specs.length,
    1,
    "the page keeps what the model said",
  );
  assert.deepEqual(
    readObject<Reading>(readingKey).products,
    [],
    "and the reading does not publish it",
  );
});

test("a transcription that fails is retried by the queue, and on the last attempt written down so the reading can finish", async () => {
  const capacity = new Error("3040: capacity temporarily exceeded");
  const { env, asked, read, readObject } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    () => capacity,
  );
  await assert.rejects(
    seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium),
    /capacity/,
    "thrown, so the queue delivers it again",
  );
  assert.equal(
    read(partKey.page(SHA, READER, 1)),
    undefined,
    "and nothing is written that would stop the retry",
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, LAST_ATTEMPT, pdfium);
  assert.deepEqual(
    [
      readObject<SeenPage>(partKey.page(SHA, READER, 1)).markdown,
      readObject<SeenPage>(partKey.page(SHA, READER, 1)).failed,
    ],
    ["", "not transcribed: 3040: capacity temporarily exceeded"],
  );
  assert.deepEqual(
    [readObject<Reading>(readingKey).failed, readObject<Reading>(readingKey).products],
    [1, []],
  );
  assert.equal(asked.length, 2, "one transcription on each attempt, and nothing to read");
});

test("a read that fails after the page was written down keeps what was written", async () => {
  const { env, readObject, text } = world(
    { [`archive/${SHA}`]: tinyPdf([BLACK_BOX]) },
    kimi(
      ["| Weight | 230 g |", "| Weight | 230 g |"],
      () => new Error("3040: capacity temporarily exceeded"),
    ),
  );
  await assert.rejects(
    seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium),
    /capacity/,
  );
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, LAST_ATTEMPT, pdfium);
  const page = readObject<SeenPage>(partKey.page(SHA, READER, 1));
  assert.deepEqual(
    [page.markdown, page.products, page.failed],
    ["| Weight | 230 g |", [], "not read: 3040: capacity temporarily exceeded"],
  );
  assert.ok(
    text(transcriptKey)?.includes("| Weight | 230 g |"),
    "the transcription is the part worth keeping, and it is kept",
  );
});

test("a page PDFium cannot draw is written down at once, without asking a model anything", async () => {
  const { env, asked, readObject } = world({
    [`archive/${SHA}`]: new TextEncoder().encode("%PDF-1.4 and then nothing"),
  });
  await seePage({ kind: "vision-page", ...ids, page: 1, pages: 1 }, env, 1, pdfium);
  assert.equal(asked.length, 0);
  assert.match(
    readObject<SeenPage>(partKey.page(SHA, READER, 1)).failed,
    /^not drawn: PDFium could not open it/,
  );
  assert.equal(readObject<Reading>(readingKey).failed, 1);
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

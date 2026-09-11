import assert from "node:assert/strict";
import { test } from "node:test";
import { type ReadWindow, readDocument } from "../src/extract.ts";
import {
  CHUNK_CHARACTERS,
  CONVERTER,
  chunk,
  EXTRACT_MODEL,
  EXTRACTOR_ID,
  mergeReports,
  namesOneProduct,
  pageOffsets,
  type Reported,
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
    const window = WINDOWS.findIndex((w) => w.text === input.messages[1].content) + 1;
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
    "each figure has the page its window starts on, never the model's",
  );
  assert.equal(readObject<ReadWindow>(windowKey(2)).products[0].model, "S-600");

  await readDocument(message, env, 1);
  assert.equal(asked.length, 3, "a document read before is not read again");
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

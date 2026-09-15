import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_CHARACTERS, CHUNK_OVERLAP, chunk } from "../apps/worker/src/reading.ts";
import { keptWindows, lookUpPages, noPages, printedPages } from "../tools/gate/pages.ts";

/** Words with no digit in them, so filler never prints a figure's value. */
const filler = (characters: number): string =>
  "the quick brown fox jumps over the lazy dog "
    .repeat(Math.ceil(characters / 44))
    .slice(0, characters);

/**
 * A converted sheet long enough for two windows: the first starts in the title and metadata, before
 * any page heading, and the second starts on page 3. The absorption row sits where they overlap.
 */
const SHEET = [
  "# sheet.pdf",
  "## Metadata",
  "- PDFFormatVersion=1.7",
  "",
  "## Contents",
  "### Page 1",
  "| Weight | 11 kg |",
  filler(2000),
  "### Page 2",
  filler(2500),
  "### Page 3",
  "| Nominal voltage | 12.8 V |",
  filler(900),
  "| Absorption voltage | 14.4 V |",
  filler(2100),
  "### Page 4",
  "| Float voltage | 13.6 V |",
  filler(3000),
].join("\n");

test("the sheet is cut the way the reader cut it: a window with no page, then one starting on page 3", () => {
  const windows = chunk(SHEET);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.page, undefined);
  assert.equal(windows[1]?.page, 3);
  const absorption = SHEET.indexOf("| Absorption voltage");
  assert.ok(absorption >= CHUNK_CHARACTERS - CHUNK_OVERLAP && absorption < CHUNK_CHARACTERS);
});

test("a figure from a window that starts before the first page heading gets the page it is printed on", () => {
  const products = [{ model: "B-100", specs: [{ name: "Weight", value: "11", unit: "kg" }] }];
  const { products: out, counts } = printedPages(products, SHEET, [
    { window: 1, products: [{ model: "B-100", specs: [{ name: "Weight", value: "11" }] }] },
  ]);
  assert.equal(out[0]?.specs[0]?.page, 1);
  assert.deepEqual(counts, { ...noPages(), set: 1 });
});

test("a value later in its window moves from the window's first page to its own, and a right page stays", () => {
  const products = [
    {
      model: "B-100",
      specs: [
        { name: "Float voltage", value: "13.6", page: 3 },
        { name: "Nominal voltage", value: "12.8", page: 3 },
      ],
    },
  ];
  const { products: out, counts } = printedPages(products, SHEET, [
    {
      window: 1,
      products: [{ model: "B-100", specs: [{ name: "Nominal voltage", value: "12.8" }] }],
    },
    {
      window: 2,
      products: [{ model: "B-100", specs: [{ name: "Float voltage", value: "13.6" }] }],
    },
  ]);
  assert.deepEqual(
    out[0]?.specs.map((s) => s.page),
    [4, 3],
  );
  assert.deepEqual(counts, { ...noPages(), moved: 1, kept: 1 });
});

test("a figure printed nowhere in its window keeps the page it had", () => {
  const products = [{ model: "B-100", specs: [{ name: "Cycle life", value: "6000", page: 3 }] }];
  const { products: out, counts } = printedPages(products, SHEET, [
    { window: 2, products: [{ model: "B-100", specs: [{ name: "Cycle life", value: "6000" }] }] },
  ]);
  assert.equal(out[0]?.specs[0]?.page, 3);
  assert.deepEqual(counts, { ...noPages(), unfound: 1 });
});

test("with no converted text, or only a window the text no longer has, nothing changes", () => {
  const products = [
    { model: "B-100", specs: [{ name: "Float voltage", value: "13.6", page: 3 }] },
    { model: "B-200", specs: [{ name: "Weight", value: "11" }] },
  ];
  const parts = [
    { window: 1, products: [{ model: "B-200", specs: [{ name: "Weight", value: "11" }] }] },
    {
      window: 2,
      products: [{ model: "B-100", specs: [{ name: "Float voltage", value: "13.6" }] }],
    },
  ];
  for (const [markdown, windows] of [
    ["", parts],
    ["", []],
    [SHEET, [{ window: 7, products: parts[1]?.products ?? [] }]],
  ] as const) {
    const { products: out, counts } = printedPages(products, markdown, windows);
    assert.deepEqual(out, products);
    assert.deepEqual(counts, { ...noPages(), unfound: 2 });
  }
});

test("a reading that kept no windows is looked up in the windows starting on the page each figure cites", () => {
  const products = [
    {
      model: "B-100",
      specs: [
        { name: "Float voltage", value: "13.6", page: 3 },
        { name: "Weight", value: "11" },
        // Printed in the first window, which starts on no page, so a figure citing page 2 is not from it.
        { name: "Nominal voltage", value: "12.8", page: 2 },
      ],
    },
  ];
  const { products: out, counts } = printedPages(products, SHEET, []);
  assert.deepEqual(
    out[0]?.specs.map((s) => s.page),
    [4, 1, 2],
  );
  assert.deepEqual(counts, { ...noPages(), set: 1, moved: 1, unfound: 1 });
});

test("a figure two overlapping windows reported is one figure with one page, not two", () => {
  const products = [{ model: "B-100", specs: [{ name: "Absorption voltage", value: "14.4" }] }];
  const reported = [{ model: "B-100", specs: [{ name: "Absorption voltage", value: "14.4" }] }];
  const { products: out, counts } = printedPages(products, SHEET, [
    {
      window: 2,
      products: [
        { model: "b-100 ", specs: [{ name: "absorption voltage ", value: "14.4", page: 3 }] },
      ],
    },
    { window: 1, products: reported },
  ]);
  assert.equal(out[0]?.specs.length, 1);
  assert.equal(out[0]?.specs[0]?.page, 3);
  assert.deepEqual(counts, { ...noPages(), set: 1 });
});

test("an archived value that is not a window is left out, and the reading falls back to its pages", () => {
  const archived = [
    null,
    7,
    "window-0001",
    [{ window: 1, products: [] }],
    { window: 1 },
    { window: 1, products: null },
    { window: 1.5, products: [] },
    // The Worker counts windows from one, so nothing at zero or below is a window it wrote.
    {
      window: 0,
      products: [{ model: "B-100", specs: [{ name: "Float voltage", value: "13.6" }] }],
    },
    { window: -1, products: [] },
    { products: [{ model: "B-100", specs: [{ name: "Weight", value: "11" }] }] },
  ];
  assert.deepEqual(keptWindows(archived), []);
  const products = [{ model: "B-100", specs: [{ name: "Float voltage", value: "13.6", page: 3 }] }];
  const { products: out, counts } = printedPages(products, SHEET, keptWindows(archived));
  assert.equal(out[0]?.specs[0]?.page, 4);
  assert.deepEqual(counts, { ...noPages(), moved: 1 });
});

test("a window part that is not a reading's shape is passed over rather than trusted", () => {
  const products = [{ model: "B-100", specs: [{ name: "Weight", value: "11" }] }];
  const { counts } = printedPages(products, SHEET, [
    {
      window: 1,
      products: [
        null,
        "B-100",
        { model: 7, specs: [] },
        { model: "B-100", specs: [{ name: 11, value: "11" }] },
      ],
    },
  ]);
  assert.deepEqual(counts, { ...noPages(), unfound: 1 });
});

test("a reading whose kept text or windows cannot be read is left as read and reported, apart from one with no text", async () => {
  const products = [
    { model: "LFP-12100", specs: [{ name: "Nominal voltage", value: "12.8 V", page: 1 }] },
  ];
  assert.deepEqual(
    await lookUpPages(products, {
      text: async () => {
        throw new Error("/archive: HTTP 500");
      },
      windows: async () => [],
    }),
    { status: "unreadable", error: "/archive: HTTP 500" },
    "a failed fetch leaves the reading as read",
  );
  assert.deepEqual(
    await lookUpPages(products, {
      text: async () => SHEET,
      windows: async () => {
        throw new Error("unbalanced JSON in the archive stream");
      },
    }),
    { status: "unreadable", error: "unbalanced JSON in the archive stream" },
    "and so does a window stream that is not JSON",
  );
  assert.deepEqual(
    await lookUpPages(products, { text: async () => undefined, windows: async () => [] }),
    { status: "no-text" },
  );
  const looked = await lookUpPages(products, { text: async () => SHEET, windows: async () => [] });
  assert.equal(looked.status, "looked");
  if (looked.status === "looked") {
    const { set, moved, kept, unfound } = looked.counts;
    assert.equal(set + moved + kept + unfound, 1, "the one figure is counted once");
    assert.equal(looked.windows, 0);
    assert.equal(looked.products.length, 1);
  }
});

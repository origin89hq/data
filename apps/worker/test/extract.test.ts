import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK_CHARACTERS,
  chunk,
  mergeReports,
  namesOneProduct,
  pageOffsets,
  statesOneFigure,
} from "../src/reading.ts";

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

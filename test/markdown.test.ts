import assert from "node:assert/strict";
import { test } from "node:test";
import { cell } from "../src/markdown.ts";

test("a table cell keeps a pipe as text and a line break as a space", () => {
  assert.equal(cell("SmartSolar MPPT100|20"), "SmartSolar MPPT100\\|20");
  assert.equal(cell("first line\nsecond\r\nthird"), "first line second third");
  assert.equal(cell("  plain  "), "plain");
  assert.equal(cell(""), "");
});

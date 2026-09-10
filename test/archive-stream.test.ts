import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonValues } from "../tools/gate/archive.ts";

test("a stream of compact objects, one per line, reads back as those objects", () => {
  assert.deepEqual(jsonValues('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
});

test("objects written pretty still read back, which splitting on newlines silently would not", () => {
  const pretty = `{\n  "a": 1,\n  "b": [1, 2]\n}\n{\n  "a": 2\n}\n`;
  assert.deepEqual(jsonValues(pretty), [{ a: 1, b: [1, 2] }, { a: 2 }]);
  assert.equal(
    pretty.split("\n").filter(Boolean).length,
    7,
    "the naive reader would have seen seven broken lines",
  );
});

test("braces inside strings do not end a value early", () => {
  assert.deepEqual(jsonValues('{"a":"}{"}\n{"b":"\\"}"}'), [{ a: "}{" }, { b: '"}' }]);
});

test("an empty stream is no values, and a truncated one is refused rather than half-read", () => {
  assert.deepEqual(jsonValues(""), []);
  assert.deepEqual(jsonValues("   \n "), []);
  assert.throws(() => jsonValues('{"a":1}\n{"b":'), /unbalanced/);
});

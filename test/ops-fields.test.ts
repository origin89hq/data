import assert from "node:assert/strict";
import { test } from "node:test";
import { draftObject, editField } from "../apps/site/src/ops/fields.ts";

const raw = JSON.stringify({
  id: "battery-a",
  manufacturer: "maker",
  name: "Battery A",
  aliases: ["A"],
  dialects: [],
});
test("a field correction retains nested values without adding absent review metadata", () => {
  const value = draftObject(editField("models", raw, "name", "Battery B"));
  assert.deepEqual(value, {
    id: "battery-a",
    manufacturer: "maker",
    name: "Battery B",
    aliases: ["A"],
    dialects: [],
  });
});
test("clearing optional values removes them while blank required fields remain invalid", () => {
  const variant = editField("models", raw, "variant", "48V");
  assert.equal(draftObject(variant)?.variant, "48V");
  assert.equal(draftObject(editField("models", variant, "variant", ""))?.variant, undefined);
  assert.equal(draftObject(editField("models", raw, "name", ""))?.name, "");
});
test("printed specification values remain strings while page numbers become numeric", () => {
  const spec = JSON.stringify({
    id: "figure-a",
    model: "battery-a",
    name: "Voltage",
    value: "12/24",
    source: "sheet-a",
    confidence: "vendor-doc",
  });
  const changed = editField("specs", editField("specs", spec, "value", "0.05"), "page", "2");
  assert.equal(draftObject(changed)?.value, "0.05");
  assert.equal(draftObject(changed)?.page, 2);
  assert.equal(draftObject(editField("specs", changed, "page", ""))?.page, undefined);
});
test("invalid JSON and fields outside the editor cannot silently rewrite a record", () => {
  for (const input of ["{", "[]", "null", "42"]) assert.equal(draftObject(input), undefined);
  assert.throws(() => editField("models", "{", "name", "B"));
  assert.throws(() => editField("models", raw, "id", "battery-b"));
  assert.throws(() => editField("models", raw, "unknown", "B"));
});

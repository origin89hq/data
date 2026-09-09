import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRecords } from "../src/records.ts";

const exported = JSON.parse(readFileSync(new URL("../scraper/manufacturers.json", import.meta.url), "utf8")) as { id: string; domains: string[] }[];
const records = loadRecords();

test("the bundled list matches the records it was generated from", () => {
  const expected = records.manufacturers.filter((m) => m.domains.length > 0).map((m) => ({ id: m.id, domains: m.domains })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(exported, expected, "run `just export-makers` after changing a manufacturer's domains");
});

test("every exported maker claims at least one domain, since discovery has nothing to look at otherwise", () => {
  for (const m of exported) assert.ok(m.domains.length > 0, `${m.id} has no domain`);
});

test("a maker with no domain is left out rather than shipped as an instance that must fail", () => {
  const without = records.manufacturers.filter((m) => m.domains.length === 0).map((m) => m.id);
  for (const id of without) assert.equal(exported.some((m) => m.id === id), false, `${id} claims no domain and should not be shipped`);
});

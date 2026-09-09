import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sources = ["seller-crawl", "page-crawl", "manufacturer-crawl"].map((n) => [n, readFileSync(new URL(`../src/${n}.ts`, import.meta.url), "utf8")] as const);

test("every run clears its own prefix before it writes anything", () => {
  for (const [name, source] of sources) {
    assert.match(source, /clearPrefix\(this\.env\.ARCHIVE/, `${name} would leave an earlier run's objects behind`);
    assert.ok(source.indexOf("clearPrefix(this.env.ARCHIVE") < source.indexOf("ARCHIVE.put("), `${name} writes before it clears, so two runs would merge`);
  }
});

test("a run clears its own prefix and nothing wider", () => {
  for (const [name, source] of sources) {
    const call = /clearPrefix\(this\.env\.ARCHIVE, `([^`]+)`\)/.exec(source);
    assert.ok(call, `${name} has no readable clearPrefix call`);
    assert.equal(call[1], "${prefix}/", `${name} clears ${call[1]} rather than its own run`);
    // And that prefix has to end at this run's date, so clearing it cannot reach another run.
    const defined = /const prefix = `([^`]+)`;/.exec(source);
    assert.ok(defined, `${name} defines no prefix`);
    assert.ok(defined[1].endsWith("${checkedAt}"), `${name} builds its prefix as ${defined[1]}, which is wider than one run`);
    assert.ok(!defined[1].startsWith("archive/"), `${name} would clear the content-addressed archive, which no run owns`);
  }
});

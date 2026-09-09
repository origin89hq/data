import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/supervise.ts", import.meta.url), "utf8");

test("the supervisor never approves, because a gate something else can open is not a gate", () => {
  assert.doesNotMatch(source, /sendEvent/, "sending the approval event would make the download automatic");
  assert.doesNotMatch(source, /crawl-approved|APPROVAL_EVENT/, "the supervisor must not know how to approve");
  assert.match(source, /report\.blocked\.push/, "an unapproved maker is reported, not resolved");
});

test("it only fetches specification pages that were adopted into the feed list", () => {
  assert.match(source, /pages\.has\(maker\.maker\)/, "a page nobody adopted is not fetched");
});

test("a classification short of its own manifest is a concern, not something to retry forever", () => {
  assert.match(source, /report\.concerns\.push/);
  assert.match(source, /classified \$\{seller\.classified\.written\} of/);
});

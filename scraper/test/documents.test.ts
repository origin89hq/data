import { test } from "node:test";
import assert from "node:assert/strict";
import { CrawlApproval, decodeEntities, documentLinks, hostAllowed, isDocument, permitted, planFor, type Found } from "../src/documents.ts";

const domains = ["victronenergy.com"];

test("a host counts for a maker only on a dot boundary, so a lookalike domain is not theirs", () => {
  assert.equal(hostAllowed("victronenergy.com", domains), true);
  assert.equal(hostAllowed("www.victronenergy.com", domains), true);
  assert.equal(hostAllowed("files.victronenergy.com", domains), true);
  assert.equal(hostAllowed("notvictronenergy.com", domains), false);
  assert.equal(hostAllowed("victronenergy.com.evil.test", domains), false);
});

test("only documents are collected; another page to read is not one", () => {
  assert.equal(isDocument("https://x.test/a/manual.pdf"), true);
  assert.equal(isDocument("https://x.test/a/MANUAL.PDF?v=2"), true);
  assert.equal(isDocument("https://x.test/products/mppt"), false);
  assert.equal(isDocument("not a url"), false);
});

test("links are made absolute, deduplicated, and dropped when they leave the maker's hosts", () => {
  const html = `
    <a href="/upload/manual.pdf">a</a>
    <a href="/upload/manual.pdf#page=4">same file</a>
    <a href="https://files.victronenergy.com/spec.pdf">b</a>
    <a href="https://cdn.other.test/manual.pdf">someone else's</a>
    <a href="/products/mppt">a page</a>
    <a href="mailto:x@y.test">mail</a>`;
  const found = documentLinks(html, "https://www.victronenergy.com/support/", domains);
  assert.deepEqual(found.map((f) => f.url), ["https://files.victronenergy.com/spec.pdf", "https://www.victronenergy.com/upload/manual.pdf"]);
});

test("an href's entities are markup, not part of the address, and fetching them literally returns nothing", () => {
  assert.equal(decodeEntities("a&amp;b"), "a&b");
  assert.equal(decodeEntities("a&#38;b"), "a&b");
  assert.equal(decodeEntities("a&#x26;b"), "a&b");
  assert.equal(decodeEntities("plain"), "plain");
  const html = `<a href="/upload/TERMS-&amp;-CONDITIONS.pdf">terms</a>`;
  assert.deepEqual(documentLinks(html, "https://www.victronenergy.com/x", domains).map((f) => f.url), ["https://www.victronenergy.com/upload/TERMS-&-CONDITIONS.pdf"]);
});

test("the plan states what is unknown rather than counting it as zero", () => {
  const found: Found[] = [
    { url: "https://a.victronenergy.com/1.pdf", host: "a.victronenergy.com", bytes: 100 },
    { url: "https://b.victronenergy.com/2.pdf", host: "b.victronenergy.com" },
  ];
  const plan = planFor("victron-energy", found);
  assert.equal(plan.documents, 2);
  assert.equal(plan.knownBytes, 100);
  assert.equal(plan.sizesUnknown, 1);
  assert.deepEqual(plan.hosts, ["a.victronenergy.com", "b.victronenergy.com"]);
});

test("a refusal permits nothing, and so does an approval naming no host that was found", () => {
  const found: Found[] = [{ url: "https://a.victronenergy.com/1.pdf", host: "a.victronenergy.com" }];
  assert.deepEqual(permitted(found, CrawlApproval.parse({ approved: false, approvedBy: "David" })), []);
  assert.deepEqual(permitted(found, CrawlApproval.parse({ approved: true, approvedBy: "David", hosts: ["elsewhere.test"] })), []);
});

test("an approval narrows what discovery found and can never widen it", () => {
  const found: Found[] = [
    { url: "https://a.victronenergy.com/1.pdf", host: "a.victronenergy.com" },
    { url: "https://b.victronenergy.com/2.pdf", host: "b.victronenergy.com" },
  ];
  assert.equal(permitted(found, CrawlApproval.parse({ approved: true, approvedBy: "David" })).length, 2);
  assert.deepEqual(permitted(found, CrawlApproval.parse({ approved: true, approvedBy: "David", hosts: ["a.victronenergy.com"] })).map((f) => f.host), ["a.victronenergy.com"]);
  assert.equal(permitted(found, CrawlApproval.parse({ approved: true, approvedBy: "David", limit: 1 })).length, 1);
});

test("an approval with no named approver is refused, because an unattributed go-ahead is not one", () => {
  assert.throws(() => CrawlApproval.parse({ approved: true }));
  assert.throws(() => CrawlApproval.parse({ approved: true, approvedBy: "" }));
  assert.throws(() => CrawlApproval.parse({ approved: true, approvedBy: "D", extra: "field" }));
});

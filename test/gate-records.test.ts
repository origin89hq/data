import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Brand } from "@origin89/equipment-schema/brand";
import { loadRecords, type Records, writeRecords } from "../src/records.ts";
import { validate } from "../src/validate.ts";

const evidence = {
  sellers: ["shop"],
  listings: 3,
  inScope: 3,
  kinds: ["battery 3"],
  models: ["S-550"],
  proposed: [],
  examples: [],
  seenAt: "2026-09-09",
};
const decided: Brand = {
  id: "rolls",
  brand: "Rolls",
  decision: "manufacturer",
  manufacturer: "rolls-battery",
  evidence,
  checkedAt: "2026-09-09",
  reviewedBy: "David",
  basis: "S-550 is a Rolls model in the catalogue",
};

function fixture(brands: Brand[] = [decided]): Records {
  return {
    families: [{ id: "modbus-rs485", intro: "# T", order: ["a"] }],
    dialects: [
      {
        id: "a",
        family: "modbus-rs485",
        driver: { status: "possible" },
        confidence: "vendor-doc",
        refuter: "checked",
        sources: [{ source: "s1", citation: "https://x/1" }],
      },
    ],
    sources: [{ id: "s1", url: "https://x/1" }],
    manufacturers: [{ id: "rolls-battery", name: "Rolls Battery", domains: ["rollsbattery.com"] }],
    brands,
    models: [],
    specs: [],
  };
}

test("a consistent gate validates", () => {
  assert.deepEqual(validate(fixture()).errors, []);
});

test("a brand resolved to a manufacturer that does not exist is an error, not a dangling pointer", () => {
  assert.match(
    validate(fixture([{ ...decided, manufacturer: "ghost" }])).errors.join("\n"),
    /names manufacturer ghost/,
  );
});

test("a decision with no reviewer or no date is refused, because a decision is a person's", () => {
  assert.match(
    validate(fixture([{ ...decided, reviewedBy: undefined }])).errors.join("\n"),
    /no reviewer or date/,
  );
  assert.match(
    validate(fixture([{ ...decided, checkedAt: undefined }])).errors.join("\n"),
    /no reviewer or date/,
  );
});

test("the bulk classifier cannot name itself as the reviewer, because a guess over a title is evidence", () => {
  assert.match(
    validate(
      fixture([{ ...decided, reviewedBy: "ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast@p2" }]),
    ).errors.join("\n"),
    /bulk classifier named as the reviewer/,
  );
  assert.deepEqual(
    validate(fixture([{ ...decided, reviewedBy: "Claude (agent review)" }])).errors,
    [],
    "a named agent working the queue is attributable, which is what the rule is for",
  );
});

test("a decision with no basis is refused, because nobody can check an assertion", () => {
  assert.match(validate(fixture([{ ...decided, basis: undefined }])).errors.join("\n"), /no basis/);
  const waiting: Brand = {
    id: "mystery",
    brand: "Mystery",
    decision: "unresolved",
    evidence,
    basis: "premature",
  };
  assert.match(
    validate(fixture([waiting])).errors.join("\n"),
    /unresolved but already carries a basis/,
  );
});

test("an out-of-scope brand needs a reason, so the decision can be revisited", () => {
  const skipped: Brand = {
    id: "lodge",
    brand: "Lodge",
    decision: "out-of-scope",
    evidence,
    checkedAt: "2026-09-09",
    reviewedBy: "David",
    basis: "cookware",
  };
  assert.match(validate(fixture([skipped])).errors.join("\n"), /out of scope with no reason/);
  assert.deepEqual(
    validate(fixture([{ ...skipped, reason: "cookware" }])).errors.filter((e) =>
      e.includes("lodge"),
    ),
    [],
  );
});

test("an unresolved brand carrying an answer or a reviewer is refused, and is counted as waiting", () => {
  const waiting: Brand = { id: "mystery", brand: "Mystery", decision: "unresolved", evidence };
  const report = validate(fixture([waiting]));
  assert.deepEqual(
    report.errors.filter((e) => e.includes("mystery")),
    [],
  );
  assert.equal(report.review["brand waiting at the gate"], 1);
  assert.match(
    validate(fixture([{ ...waiting, manufacturer: "rolls-battery" }])).errors.join("\n"),
    /already carries an answer/,
  );
  assert.match(
    validate(fixture([{ ...waiting, reviewedBy: "David" }])).errors.join("\n"),
    /marked reviewed/,
  );
});

test("two brand records claiming one string is an error, since a sighting could resolve either way", () => {
  const twin: Brand = { ...decided, id: "rolls-2", brand: "rolls" };
  assert.match(validate(fixture([decided, twin])).errors.join("\n"), /both claim the string/);
});

test("re-importing the catalogue leaves the gate alone, which passing it empty arrays once would not have", () => {
  const dir = mkdtempSync(join(tmpdir(), "offgrid-gate-"));
  try {
    writeRecords(fixture(), dir);
    const before = loadRecords(dir);
    writeRecords({ ...before, families: [], dialects: [], sources: [] }, dir, [
      "families",
      "dialects",
      "sources",
    ]);
    const after = loadRecords(dir);
    assert.deepEqual(after.brands, before.brands);
    assert.deepEqual(after.manufacturers, before.manufacturers);
    assert.deepEqual(after.dialects, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

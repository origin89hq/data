import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Dialect } from "@origin89/equipment-schema/dialect";
import { CatalogueParseError, parseFamilyFile } from "../tools/catalogue/parse.ts";
import { withExtensions } from "../tools/catalogue/preserve.ts";
import { renderFamilyFile } from "../tools/catalogue/render.ts";
import { locatorOf, SourceTable } from "../tools/catalogue/sources.ts";

const tiny = readFileSync(new URL("./fixtures/tiny.md", import.meta.url), "utf8");

function parseTiny() {
  const sources = new SourceTable();
  return { parsed: parseFamilyFile("modbus-rs485", tiny, (c) => sources.idFor(c)), sources };
}

test("a family file renders back byte for byte, so nothing the prose held is lost", () => {
  const { parsed } = parseTiny();
  const rendered = renderFamilyFile(parsed.family, new Map(parsed.dialects.map((d) => [d.id, d])));
  assert.equal(rendered, tiny);
});

test("every field the catalogue writes lands in a named record field", () => {
  const { parsed } = parseTiny();
  const [one, two] = parsed.dialects;
  assert.deepEqual(one.driver, { status: "shipped", id: "cabin-acme" });
  assert.equal(one.refuter, "checked");
  assert.deepEqual(one.seeAlso, ["acme-two"]);
  assert.deepEqual(one.reports, ["battery-voltage", "battery-current"]);
  assert.deepEqual(one.accepts, ["set-switch"]);
  assert.deepEqual(one.models, [
    { name: "One-100", rating: "100 A", notes: "Installed here." },
    { name: "One-200" },
  ]);
  assert.equal(one.gotchas?.length, 2);
  assert.equal(one.unmappedReports, "fault code (0x0001)");
  assert.equal(two.refuter, "not-checked");
  assert.equal(two.sharedMapClaimDropped, true);
  assert.equal(two.possibleDuplicate, undefined);
  assert.equal(one.possibleDuplicate, true);
  assert.equal(parsed.claimedCount, 2);
  for (const d of parsed.dialects) Dialect.parse(d);
});

test("an entry with a paragraph the parser does not know is refused, not silently dropped", () => {
  const broken = tiny.replace("- Nothing to build on.", "Some prose nobody labelled.");
  assert.throws(
    () => parseFamilyFile("modbus-rs485", broken, () => "x"),
    (e: unknown) => e instanceof CatalogueParseError && /unrecognised paragraph/.test(e.message),
  );
});

test("an unknown driver marker is refused rather than read as possible", () => {
  const broken = tiny.replace("**Driver** 💡 none", "**Driver** 🤷 maybe");
  assert.throws(() => parseFamilyFile("modbus-rs485", broken, () => "x"), /unrecognised driver/);
});

test("a table row with the wrong number of cells is refused", () => {
  const broken = tiny.replace("| One-200 |  |  |", "| One-200 |  |");
  assert.throws(() => parseFamilyFile("modbus-rs485", broken, () => "x"), /cells/);
});

test("an empty family is refused", () => {
  assert.throws(
    () => parseFamilyFile("modbus-rs485", "# Nothing\n", () => "x"),
    /no dialect entries/,
  );
});

test("two citations of one URL share a source; a fragment does not make a second one", () => {
  const t = new SourceTable();
  const a = t.idFor("https://example.com/a.pdf — page 1");
  const b = t.idFor("https://example.com/a.pdf#page=4 — page 4");
  assert.equal(a, b);
  assert.equal(t.all().length, 1);
});

test("two different locators that slug alike get distinct ids in first-seen order", () => {
  const t = new SourceTable();
  const a = t.idFor("https://example.com/a.pdf");
  const b = t.idFor("https://example.com/a.html");
  assert.notEqual(a, b);
  assert.equal(b, `${a}-2`);
});

test("a path behind the earlier checkout's absolute prefix is the repo-relative path", () => {
  assert.deepEqual(locatorOf("committed at /Users/someone/dev/solar/docs/x-manual.pdf — p.4"), {
    kind: "path",
    path: "docs/x-manual.pdf",
  });
  assert.deepEqual(locatorOf("Acme, product page only"), { kind: "none" });
  assert.deepEqual(locatorOf("see https://a.b/c.pdf, p.2"), {
    kind: "url",
    url: "https://a.b/c.pdf",
  });
});

test("an import keeps a dialect's readings and codes, and the sources only they cite, from the record it replaces", () => {
  const { parsed, sources } = parseTiny();
  const first = parsed.dialects[0];
  assert.ok(first);
  const reading = {
    metric: "pv-voltage" as const,
    at: "0x3100",
    unit: "V",
    scale: 0.01,
    origin: "measured" as const,
    source: "driver-map",
  };
  const held = Dialect.parse({ ...first, readings: [reading] });
  const stale = Dialect.parse({ ...first, id: "gone-from-the-catalogue", readings: [reading] });
  const out = withExtensions(parsed.dialects, [held, stale], sources.all(), [
    { id: "driver-map", path: "crates/x/src/map.rs" },
    { id: "unrelated", path: "docs/y.pdf" },
  ]);
  assert.deepEqual(out.dialects[0]?.readings, [reading], "the readings come across by id");
  assert.equal(
    out.dialects.length,
    parsed.dialects.length,
    "a dialect the catalogue dropped brings nothing",
  );
  assert.ok(
    out.sources.some((s) => s.id === "driver-map"),
    "the source only the reading cites is kept",
  );
  assert.ok(!out.sources.some((s) => s.id === "unrelated"), "an uncited old source is not");
  assert.deepEqual(
    withExtensions(parsed.dialects, [], sources.all(), []).dialects,
    parsed.dialects,
    "with no records to keep from, the parse is what is written",
  );
});

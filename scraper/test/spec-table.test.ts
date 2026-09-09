import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpecTables, splitValue } from "../src/spec-table.ts";

/** The shape a maker publishes: a column per model, a row per figure, units attached to values. */
const page = `<table>
<tr><th></th><th>MPPT 75/10</th><th>MPPT 75/15</th><th>MPPT 100/20</th></tr>
<tr><td>Battery voltage</td><td colspan="2">12V or 24V</td><td>12V, 24V, or 48V</td></tr>
<tr><td>Maximum battery current</td><td>10A</td><td>15A</td><td>20A</td></tr>
<tr><td>Nominal PV power, 48V</td><td>-</td><td>-</td><td>1160W</td></tr>
<tr><td>Automatic load disconnect</td><td>Yes</td><td>Yes</td><td>Yes</td></tr>
</table>
<table><tr><th>Note</th><th>Meaning</th></tr><tr><td>1a</td><td>a footnote, not a product</td></tr></table>`;

test("a column per model becomes a product, with the figure names the maker wrote", () => {
  const products = parseSpecTables(page);
  assert.deepEqual(products.map((p) => p.model), ["MPPT 75/10", "MPPT 75/15", "MPPT 100/20"]);
  const small = products[0];
  assert.deepEqual(small.specs.find((s) => s.name === "Maximum battery current"), { name: "Maximum battery current", value: "10", unit: "A" });
});

test("a cell spanning two columns fills both, so a row still lines up with its header", () => {
  const [a, b, c] = parseSpecTables(page);
  assert.equal(a.specs.find((s) => s.name === "Battery voltage")?.value, "12V or 24V");
  assert.equal(b.specs.find((s) => s.name === "Battery voltage")?.value, "12V or 24V");
  assert.equal(c.specs.find((s) => s.name === "Battery voltage")?.value, "12V, 24V, or 48V");
});

test("a dash is absence, not a figure, so a model without one carries nothing", () => {
  const [a, , c] = parseSpecTables(page);
  assert.equal(a.specs.some((s) => s.name === "Nominal PV power, 48V"), false);
  assert.equal(c.specs.find((s) => s.name === "Nominal PV power, 48V")?.value, "1160");
});

test("a table of footnotes is not a table of products", () => {
  assert.equal(parseSpecTables(page).some((p) => p.model === "Note" || p.model === "Meaning"), false);
  assert.deepEqual(parseSpecTables("<table><tr><th>Description</th><th>Notes</th></tr><tr><td>a</td><td>b</td></tr></table>"), []);
});

test("a section header dividing the table is not a figure about the models under it", () => {
  const withHeader = `<table>
<tr><th></th><th>MPPT 75/10</th><th>MPPT 75/15</th></tr>
<tr><td>ENCLOSURE</td><td>ENCLOSURE</td><td>ENCLOSURE</td></tr>
<tr><td>Colour</td><td>Blue</td><td>Blue</td></tr>
</table>`;
  const products = parseSpecTables(withHeader);
  assert.equal(products[0].specs.some((s) => s.name === "ENCLOSURE"), false);
  assert.equal(products[0].specs.find((s) => s.name === "Colour")?.value, "Blue");
});

test("a unit is split off a plain number and left alone on anything else", () => {
  assert.deepEqual(splitValue("145W"), { name: "", value: "145", unit: "W" });
  assert.deepEqual(splitValue("-0.5 %/°C"), { name: "", value: "-0.5", unit: "%/°C" });
  assert.deepEqual(splitValue("12V or 24V"), { name: "", value: "12V or 24V" });
  assert.deepEqual(splitValue("Yes"), { name: "", value: "Yes" });
  assert.equal(splitValue("-"), undefined);
  assert.equal(splitValue("n/a"), undefined);
  assert.equal(splitValue("  "), undefined);
});

test("a page is judged on what its tables actually yield, not on its address", async () => {
  const { judgeSpecPage } = await import("../src/spec-table.ts");
  const good = judgeSpecPage("https://x.test/spec", `<table>
<tr><th></th><th>A-10</th><th>A-20</th></tr>
<tr><td>Maximum current</td><td>10A</td><td>20A</td></tr>
<tr><td>Colour</td><td>Blue</td><td>Blue</td></tr></table>`);
  assert.equal(good?.products, 2);
  assert.equal(good?.figures, 4);
  assert.equal(good?.withUnit, 2, "a unit is what separates a specification table from prose");
  assert.deepEqual(good?.models, ["A-10", "A-20"]);
  assert.equal(judgeSpecPage("https://x.test/about", "<p>About us</p>"), undefined);
});

test("a table written on its side is not a table of products", () => {
  // Rolls' battery pages put attributes across the top. Read as models they produced products
  // called "Warranty" and "5 Years", each carrying the whole battery's figures.
  const sideways = `<table>
<tr><th>Model</th><th>FLA SERIES 5000</th><th>Warranty</th><th>5 Years</th><th>40&deg;C (104&deg;F)</th></tr>
<tr><td>2-YS-62P</td><td>yes</td><td>5</td><td>x</td><td>y</td></tr></table>`;
  assert.deepEqual(parseSpecTables(sideways), []);
});

test("a header of real model codes still reads", () => {
  const upright = `<table>
<tr><th></th><th>SL-10L-12V</th><th>SL-20L-24V</th></tr>
<tr><td>Maximum current</td><td>10A</td><td>20A</td></tr></table>`;
  assert.deepEqual(parseSpecTables(upright).map((p) => p.model), ["SL-10L-12V", "SL-20L-24V"]);
});

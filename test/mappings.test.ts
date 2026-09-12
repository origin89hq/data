import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProperties, type GapRow, type PropertyRow } from "../src/properties.ts";
import { loadRecords } from "../src/records.ts";

/**
 * Each maker's mapping record, read against the maker's own released figures: one model per
 * maker whose sheet the rules were written from, with the values its rules read, a condition read
 * off a name, and a figure the rules name that stays a gap and says why.
 */
const records = loadRecords();

function of(model: string): { properties: PropertyRow[]; gaps: GapRow[] } {
  const found = records.models.find((m) => m.id === model);
  assert.ok(found, `${model} is a record`);
  const specs = records.specs.filter((s) => s.model === model);
  return buildProperties({ models: [found], specs, mappings: records.mappings, feeds: [] });
}

const values = (rows: PropertyRow[], key: string) =>
  rows.filter((p) => p.key === key && p.status === "value");
const gap = (gaps: GapRow[], key: string) => gaps.find((g) => g.key === key);
const own = (maker: string, rows: PropertyRow[]) =>
  rows.every((p) => p.mappedBy.startsWith(`rule:${maker}@`));

test("Magnum: the surge lines read in watts with their durations, the charger's amps under the charge key, and the VA continuous figure is a gap", () => {
  const { properties, gaps } = of("magnum-energy-ms4024pae");
  const surge = values(properties, "inverter.power.surge");
  assert.deepEqual(
    surge.map((p) => [p.value, p.conditions.duration]),
    [
      [4500, 1800],
      [5200, 30],
      [4800, 300],
      [5800, 5],
    ],
  );
  assert.ok(own("magnum-energy", surge));
  assert.deepEqual(
    values(properties, "charge.current.max").map((p) => [p.value, p.unit]),
    [[105, "A"]],
  );
  assert.equal(gap(gaps, "inverter.power.continuous")?.reason, "unparsed");
  // The MM1012E's charger line and the 12NP10's output line carry no unit; the rules say which.
  assert.deepEqual(
    values(of("magnum-energy-mm1012e").properties, "charge.current.max").map((p) => [
      p.value,
      p.unit,
    ]),
    [[50, "A"]],
  );
  assert.deepEqual(
    values(of("magnum-energy-12np10").properties, "inverter.power.continuous").map((p) => [
      p.value,
      p.unit,
    ]),
    [[1000, "W"]],
  );
  // The MM-AE sheet's idle lines are bare too, and the rule for that sheet reads them in watts.
  assert.deepEqual(
    values(of("magnum-energy-mm1512ae").properties, "inverter.power.idle").map((p) => [
      p.value,
      p.conditions.mode,
    ]),
    [
      [18, undefined],
      [6, "search"],
    ],
  );
  // The 12LP10 prints a bare 1000 under a heading that says watts.
  assert.deepEqual(
    values(of("magnum-energy-12lp10").properties, "inverter.power.continuous").map((p) => [
      p.value,
      p.unit,
    ]),
    [[1000, "W"]],
  );
  // The modes the sheet names in words the reader does not take as modes come from the rules.
  const idle = values(of("magnum-energy-ms2712e").properties, "inverter.power.idle");
  assert.deepEqual(
    idle.map((p) => [p.value, p.conditions.mode]),
    [
      [34, "invert"],
      [9, "search"],
    ],
  );
});

test("Samlex: the PST's watts and its surge without a time, the SEC's bulk capacity over its set value, and the SCC's array limits", () => {
  const pst = of("samlex-america-pst-1000-12hd");
  assert.deepEqual(
    values(pst.properties, "inverter.power.continuous").map((p) => [p.value, p.unit]),
    [[1000, "W"]],
  );
  assert.equal(gap(pst.gaps, "inverter.power.surge")?.reason, "needs-conditions");
  const sec = values(of("samlex-america-sec-1250ul").properties, "charge.current.max");
  assert.deepEqual(
    sec.map((p) => [p.value, p.claim]),
    [[50, "samlex-america-sec-1250ul--bulk-stage-current-capacity"]],
  );
  // The PSE-12275A prints its 2750 W under two spellings, and 1500 W for one receptacle, which is not read.
  const pse = of("samlex-america-pse-12275a");
  assert.deepEqual(
    values(pse.properties, "inverter.power.continuous").map((p) => [p.value, p.unit]),
    [[2750, "W"]],
  );
  assert.equal(gap(pse.gaps, "inverter.power.continuous"), undefined);
  // The EVO-1212F prints its watts with the power factor on the line, which stays a gap that says so.
  assert.match(
    gap(of("samlex-america-evo-1212f").gaps, "inverter.power.continuous")?.detail ?? "",
    /Watt/,
  );
  const scc = of("samlex-america-evo-30ab").properties;
  assert.deepEqual(
    values(scc, "charge.current.max").map((p) => p.value),
    [30],
  );
  assert.deepEqual(
    values(scc, "pv.voc.max").map((p) => p.value),
    [50],
  );
  assert.deepEqual(
    values(scc, "pv.isc.max").map((p) => p.value),
    [30],
  );
  assert.ok(own("samlex-america", [...sec, ...values(scc, "pv.voc.max")]));
});

test("OutBack: the Radian's watts, its three idle modes, the charger's amps, and its kVA overload figures as gaps", () => {
  const { properties, gaps } = of("outback-power-gs4048a");
  assert.deepEqual(
    values(properties, "inverter.power.continuous").map((p) => p.value),
    [3600],
  );
  assert.deepEqual(
    values(properties, "inverter.power.idle").map((p) => [p.value, p.conditions.mode]),
    [
      [34, "invert"],
      [10, "search"],
      [4, "off"],
    ],
  );
  assert.deepEqual(
    values(properties, "charge.current.max").map((p) => p.value),
    [57.5],
  );
  assert.equal(gap(gaps, "inverter.power.surge")?.reason, "unparsed");
  const flexmax = of("outback-power-flexmax-60").properties;
  assert.deepEqual(
    values(flexmax, "charge.current.max").map((p) => p.value),
    [60],
  );
  assert.deepEqual(
    values(flexmax, "pv.voc.max").map((p) => [p.value, p.claim]),
    [[150, "outback-power-flexmax-60--pv-array-voltage"]],
  );
  assert.ok(own("outback-power", values(flexmax, "pv.voc.max")));
  // The GS3548E prints a 50 A continuous charge beside its 55 A maximum; only the maximum is read.
  const gs3548 = of("outback-power-gs3548e");
  assert.deepEqual(
    values(gs3548.properties, "charge.current.max").map((p) => p.value),
    [55],
  );
  assert.equal(gap(gs3548.gaps, "charge.current.max"), undefined);
  // The VFXR is an inverter/charger: its sheet prints a battery charger output, read under the charge key.
  assert.deepEqual(
    values(of("outback-power-vfxr3048e").properties, "charge.current.max").map((p) => p.value),
    [40],
  );
  assert.deepEqual(
    values(of("outback-power-skybox-sbx5048-120-240").properties, "pv.mppt.window").map((p) => [
      p.min,
      p.max,
    ]),
    [[200, 600]],
  );
  assert.deepEqual(
    values(of("outback-power-skybox-sbx5048-120-240").properties, "pv.isc.max").map((p) => [
      p.value,
      p.unit,
    ]),
    [[32, "A"]],
  );
  // Two FLEXmax 60 manuals state the same 48 A under two wordings: one property.
  assert.deepEqual(
    values(flexmax, "pv.isc.max").map((p) => p.value),
    [48],
  );
  assert.deepEqual(
    values(of("outback-power-fx2012t").properties, "battery.voltage.nominal").map((p) => p.values),
    [[12]],
  );
  const plr = values(of("outback-power-energycell-plr").properties, "battery.voltage.nominal");
  assert.deepEqual(
    plr.map((p) => p.values),
    [[12]],
  );
});

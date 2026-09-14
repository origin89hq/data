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

test("Magnum: the surge lines read in watts with their durations, the charger's amps under the charge key, and the VA continuous figure under the apparent key", () => {
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
  // Its '4000 VA (L-L)' is 4000 VA, the aside being the phases, under the apparent key; the watt key was never claimed by it.
  assert.deepEqual(
    values(properties, "inverter.power.apparent").map((p) => [p.value, p.unit]),
    [[4000, "VA"]],
  );
  assert.equal(gap(gaps, "inverter.power.continuous")?.reason, "no-claim");
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

test("OutBack: the Radian's watts, its three idle modes, the charger's amps, and its kVA overloads under the apparent key", () => {
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
  // Its kVA overloads are the apparent key's now, and the watt surge key was never claimed.
  assert.equal(gap(gaps, "inverter.power.surge")?.reason, "no-claim");
  assert.deepEqual(
    values(properties, "inverter.power.apparent.surge").map((p) => [
      p.value,
      p.conditions.duration,
    ]),
    [
      [4500, 1800],
      [6000, 5],
    ],
  );
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

test("SRNE: the hybrid's combined charging current over its PV-only figure, a controller's open-circuit limit, and the per-voltage PV power as a gap", () => {
  const hybrid = of("srne-4830sh3");
  const charge = values(hybrid.properties, "charge.current.max");
  assert.deepEqual(
    charge.map((p) => [p.value, p.claim]),
    [[80, "srne-4830sh3--max-hybrid-charging-current"]],
  );
  assert.ok(own("srne", charge));
  const controller = of("srne-mc2430n10");
  assert.deepEqual(
    values(controller.properties, "pv.voc.max").map((p) => p.value),
    [100],
  );
  assert.equal(gap(controller.gaps, "pv.power.max")?.detail, "two units in one figure");
  // The LC manual states its limit at 25 °C, read by the rule for that sheet with the temperature kept.
  const lc = of("srne-lc2430n10h");
  assert.deepEqual(
    values(lc.properties, "pv.voc.max").map((p) => [p.value, p.conditions, p.mappedBy]),
    [[92, { ambientTemperature: 25 }, "rule:srne@1#4"]],
  );
  // Its cold-temperature limit is printed as a sentence the parser refuses, so the key stays partial.
  assert.equal(gap(lc.gaps, "pv.voc.max")?.reason, "unparsed");
  assert.match(gap(lc.gaps, "pv.voc.max")?.detail ?? "", /beside 1 usable figure/);
});

test("Luxpower: the hybrid's PV limits per input, its DC power, and one battery current for charge and discharge", () => {
  const { properties, gaps } = of("luxpower-lxp-3-6k-hybrid");
  assert.deepEqual(
    values(properties, "inverter.power.continuous").map((p) => p.value),
    [3680],
  );
  assert.deepEqual(
    values(properties, "charge.current.max").map((p) => p.value),
    [66],
  );
  assert.deepEqual(
    values(properties, "pv.isc.max").map((p) => [p.value, p.scope]),
    [[13.7, "per-input"]],
  );
  assert.deepEqual(
    values(properties, "pv.voc.max").map((p) => p.value),
    [550],
  );
  assert.deepEqual(
    values(properties, "pv.power.max").map((p) => [p.value, p.scope]),
    [[7000, "total"]],
  );
  assert.ok(own("luxpower", values(properties, "pv.power.max")));
  // The SNA sheet prints one current for charge and discharge as '110/110 A', read as one figure.
  assert.deepEqual(
    values(of("luxpower-sna5000-wpv").properties, "charge.current.max").map((p) => [
      p.value,
      p.claim,
    ]),
    [[110, "luxpower-sna5000-wpv--max-charging-discharging-current"]],
  );
  // The LXP sheet prints no surge figure, and the SNA's has no time on its line.
  assert.equal(gap(gaps, "inverter.power.surge")?.reason, "no-claim");
  assert.deepEqual(gap(of("luxpower-sna-us-5000").gaps, "inverter.power.surge"), {
    model: "luxpower-sna-us-5000",
    key: "inverter.power.surge",
    reason: "needs-conditions",
    detail: "no duration stated",
    claims: 1,
  });
});

test("Xantrex: the Freedom's charger amps, no idle draw from its search threshold, a 40 °C continuous figure beside the plain one, and the C-series rating", () => {
  const { properties, gaps } = of("xantrex-freedom-sw-2524");
  // The sheet states the charger's output twice, once at 25 °C, which the second row keeps.
  assert.deepEqual(
    values(properties, "charge.current.max").map((p) => [p.value, p.conditions]),
    [
      [65, {}],
      [65, { ambientTemperature: 25 }],
    ],
  );
  // 'Search Watts' is the load threshold that ends search mode, not a draw, and is not read.
  assert.deepEqual(values(properties, "inverter.power.idle"), []);
  assert.equal(gap(gaps, "inverter.power.idle")?.claims, 1);
  assert.deepEqual(
    values(properties, "inverter.power.continuous").map((p) => [p.value, p.conditions]),
    [
      [2500, {}],
      [2500, { ambientTemperature: 40 }],
    ],
  );
  assert.deepEqual(
    values(properties, "inverter.voltage.ac").map((p) => p.values),
    [[230]],
  );
  assert.equal(gap(gaps, "inverter.power.surge")?.reason, "needs-conditions");
  const c35 = values(of("xantrex-c35").properties, "charge.current.max");
  assert.deepEqual(
    c35.map((p) => [p.value, p.conditions]),
    [[35, { ambientTemperature: 25 }]],
  );
  assert.ok(own("xantrex", c35));
});

test("Sol-Ark: the 15K's surges with their times, one battery current, the usable PV power, and the 12K's per-MPPT power beside its total", () => {
  const { properties, gaps } = of("sol-ark-15k-2p-lv");
  assert.deepEqual(
    values(properties, "inverter.power.surge").map((p) => [p.value, p.conditions.duration]),
    [
      [24000, 10],
      [13000, 1800],
    ],
  );
  assert.deepEqual(
    values(properties, "charge.current.max").map((p) => p.value),
    [275],
  );
  assert.deepEqual(
    values(properties, "pv.power.max").map((p) => [p.value, p.scope]),
    [[19500, "total"]],
  );
  assert.deepEqual(
    values(properties, "pv.isc.max").map((p) => p.value),
    [44],
  );
  assert.equal(gap(gaps, "inverter.voltage.ac")?.reason, "unparsed");
  const twelve = of("sol-ark-sol-ark-12k-2p-n");
  // Its total is printed '13kW(±5%)'; the tolerance is an aside, and the figure reads beside the per-MPPT one.
  assert.deepEqual(
    values(twelve.properties, "pv.power.max").map((p) => [p.value, p.scope]),
    [
      [13000, "total"],
      [6500, "per-input"],
    ],
  );
  assert.equal(gap(twelve.gaps, "pv.power.max"), undefined);
  // The 12K-P prints the allowed array size, 13 kW, beside the 12 kW it delivers; only the latter is read.
  const twelveP = of("sol-ark-sol-ark-12k-p");
  assert.deepEqual(
    values(twelveP.properties, "pv.power.max").map((p) => p.value),
    [12000],
  );
  assert.equal(gap(twelveP.gaps, "pv.power.max"), undefined);
  // The 5K's manual prints 'Max A Charge' as 185 A on a settings screen; its sheet says 120 A.
  const five = of("sol-ark-sol-ark-5k-2p-n");
  assert.deepEqual(
    values(five.properties, "charge.current.max").map((p) => [p.value, p.claim]),
    [[120, "sol-ark-sol-ark-5k-2p-n--max-battery-charge-discharge-current"]],
  );
  assert.equal(gap(five.gaps, "charge.current.max"), undefined);
});

test("EG4: the 12kPV's kilowatts as watts, its PV limits, the mini split's bare MPPT heading, and a bounded idle figure as a gap", () => {
  const { properties, gaps } = of("eg4-electronics-eg4-12kpv");
  assert.deepEqual(
    values(properties, "inverter.power.continuous").map((p) => [p.value, p.unit]),
    [[8000, "W"]],
  );
  assert.deepEqual(
    values(properties, "pv.isc.max").map((p) => p.value),
    [31],
  );
  assert.deepEqual(
    values(properties, "pv.power.max").map((p) => p.value),
    [12000],
  );
  assert.deepEqual(
    values(properties, "battery.voltage.nominal").map((p) => p.values),
    [[48]],
  );
  assert.equal(gap(gaps, "inverter.power.idle")?.reason, "unparsed");
  const mini = values(of("eg4-electronics-eg4-12k-mini-split").properties, "pv.mppt.window");
  assert.deepEqual(
    mini.map((p) => [p.min, p.max]),
    [[90, 380]],
  );
  assert.ok(own("eg4-electronics", mini));
});

test("NOCO: the NLX's voltage, energy and both battery currents, its capacity as a gap without a chemistry, and a charger's amps with their bank", () => {
  const { properties, gaps } = of("noco-nlx27");
  assert.deepEqual(
    values(properties, "battery.voltage.nominal").map((p) => p.values),
    [[12.8]],
  );
  assert.deepEqual(
    values(properties, "battery.energy").map((p) => [p.value, p.unit]),
    [[1280, "Wh"]],
  );
  assert.deepEqual(
    values(properties, "battery.charge.current.max").map((p) => p.value),
    [90],
  );
  assert.deepEqual(
    values(properties, "battery.discharge.current.max").map((p) => p.value),
    [150],
  );
  // The NLX27's sheet names its chemistry in Dutch only, so its 100 Ah waits on a rate or a chemistry.
  assert.equal(gap(gaps, "battery.capacity")?.reason, "needs-conditions");
  assert.match(gap(gaps, "battery.capacity")?.detail ?? "", /no chemistry recorded/);
  // The NLX24's sheet says LiFePO4 in English, and its capacity publishes without a rate.
  const nlx24 = values(of("noco-nlx24").properties, "battery.capacity");
  assert.deepEqual(
    nlx24.map((p) => [p.value, p.conditions]),
    [[40, {}]],
  );
  assert.ok(own("noco", nlx24));
  // A charger's 'Charging Current' is the charger's, printed per bank as '10A (12V)': 10 A at a 12 V bank.
  const charger = of("noco-genpro10x1");
  assert.deepEqual(
    values(charger.properties, "charge.current.max").map((p) => [
      p.value,
      p.conditions.bankVoltage,
    ]),
    [[10, 12]],
  );
  assert.equal(values(charger.properties, "battery.charge.current.max").length, 0);
  // Two banks' worth in one figure, '10Ax2(12V)', is still refused.
  assert.equal(gap(of("noco-genpro10x2").gaps, "charge.current.max")?.reason, "unparsed");
  // The Genius 2D manual prints the same name for a 2 A maintainer; the rules read the GEN and GENPRO sheets only.
  assert.equal(of("noco-noco").gaps.length, 0);
});

test("Energizer Solar: a module's STC figures with its watt-peak, the Force's PV limits, the PS2900H's one current under both battery keys and its timed peak, and the HP-6M's watts", () => {
  const panel = of("energizer-solar-ensp54ndgt2s450");
  assert.deepEqual(
    values(panel.properties, "panel.power.stc").map((p) => [p.value, p.unit, p.conditions.stc]),
    [[450, "W", true]],
  );
  assert.deepEqual(
    values(panel.properties, "panel.voc.stc").map((p) => p.value),
    [39.4],
  );
  assert.deepEqual(
    values(panel.properties, "panel.isc.stc").map((p) => p.value),
    [14.28],
  );
  assert.deepEqual(
    values(panel.properties, "panel.vmp.stc").map((p) => p.value),
    [33.39],
  );
  assert.deepEqual(
    values(panel.properties, "panel.imp.stc").map((p) => p.value),
    [13.48],
  );
  const force = of("energizer-solar-force-8-0ht");
  assert.deepEqual(
    values(force.properties, "pv.power.max").map((p) => [p.value, p.scope]),
    [[17600, "total"]],
  );
  assert.deepEqual(
    values(force.properties, "pv.isc.max").map((p) => [p.value, p.scope]),
    [[25, "per-input"]],
  );
  assert.deepEqual(
    values(force.properties, "pv.voc.max").map((p) => p.value),
    [1000],
  );
  const pack = of("energizer-solar-ps2900h-m");
  assert.deepEqual(
    values(pack.properties, "battery.charge.current.max").map((p) => p.value),
    [50],
  );
  assert.deepEqual(
    values(pack.properties, "battery.discharge.current.max").map((p) => p.value),
    [50],
  );
  assert.deepEqual(
    values(pack.properties, "battery.discharge.current.peak").map((p) => [
      p.value,
      p.conditions.duration,
    ]),
    [[65, 60]],
  );
  assert.deepEqual(
    values(pack.properties, "battery.energy").map((p) => p.value),
    [2880],
  );
  // Its 50 Ah has no rate and its sheet names no chemistry, so the capacity waits on one.
  assert.equal(gap(pack.gaps, "battery.capacity")?.reason, "needs-conditions");
  assert.match(gap(pack.gaps, "battery.capacity")?.detail ?? "", /no chemistry recorded/);
  assert.equal(values(pack.properties, "battery.capacity").length, 0);
  assert.deepEqual(
    values(pack.properties, "battery.voltage.nominal").map((p) => p.values),
    [[57.6]],
  );
  // The PS4000H-M is the same sheet's larger pack, filed as an inverter-charger until reviewed; as a battery its figures read.
  const larger = of("energizer-solar-ps4000h-m");
  assert.deepEqual(
    values(larger.properties, "battery.energy").map((p) => p.value),
    [4030],
  );
  assert.deepEqual(
    values(larger.properties, "battery.discharge.current.peak").map((p) => [
      p.value,
      p.conditions.duration,
    ]),
    [[65, 60]],
  );
  assert.equal(gap(larger.gaps, "battery.capacity")?.reason, "needs-conditions");
  // The HP-6M writes its battery voltage as '51.2 V d.c.', which the unit table now reads.
  const hp = of("energizer-solar-hp-6m");
  assert.deepEqual(
    values(hp.properties, "battery.voltage.nominal").map((p) => p.values),
    [[51.2]],
  );
  assert.deepEqual(
    values(hp.properties, "inverter.power.continuous").map((p) => p.value),
    [3600],
  );
  // The PS2900H stacks print 'Nominal Power' too, in kilowatts equal to their energy; a battery has no inverter output.
  assert.equal(
    values(of("energizer-solar-ps2900h-4").properties, "inverter.power.continuous").length,
    0,
  );
  // The EV charger sheet prints 'Rated Power' for the A11's 11 kW of charging, which is no inverter's output; the A11 is a load.
  assert.equal(
    values(of("energizer-solar-a11-cp").properties, "inverter.power.continuous").length,
    0,
  );
});

test("East Penn: the AVR table's kilowatt-hours and the 8GGC2's, a '12-Volts' voltage, an 'A.H.' capacity waiting on its rate, and a unitless 'Rated Capacity' as a gap", () => {
  const avr = of("east-penn-avr95-27");
  const energy = values(avr.properties, "battery.energy");
  assert.deepEqual(
    energy.map((p) => [p.value, p.unit]),
    [[2500, "Wh"]],
  );
  assert.ok(own("east-penn", energy));
  // Its 'Rated Capacity' is a bare 1235 in a column whose unit the table does not say: a gap that says so, not a value.
  assert.equal(gap(avr.gaps, "battery.capacity")?.reason, "unparsed");
  assert.equal(gap(avr.gaps, "battery.capacity")?.detail, "no unit");
  assert.equal(values(avr.properties, "battery.capacity").length, 0);
  const gel = of("east-penn-8ggc2-24v");
  assert.deepEqual(
    values(gel.properties, "battery.energy").map((p) => p.value),
    [3600],
  );
  // '155 A.H. to 1.70 VPC' is 155 Ah drawn down to a cell voltage; the sheet states no rate, so it waits.
  assert.equal(gap(gel.gaps, "battery.capacity")?.reason, "needs-conditions");
  assert.match(gap(gel.gaps, "battery.capacity")?.detail ?? "", /dischargeHours/);
  assert.deepEqual(
    values(of("east-penn-hr3500").properties, "battery.voltage.nominal").map((p) => p.values),
    [[12]],
  );
});

test("Rolls: the STACK-LV manual's bare 'Voltage' read on that manual only, its timed peak discharge, and the AGM sheet's bare 'Volts'", () => {
  const stack = of("rolls-battery-s48-100lfp-stack-lv");
  const voltage = values(stack.properties, "battery.voltage.nominal");
  assert.deepEqual(
    voltage.map((p) => p.values),
    [[51.2]],
  );
  assert.ok(own("rolls-battery", voltage));
  assert.deepEqual(
    values(stack.properties, "battery.discharge.current.peak").map((p) => [
      p.value,
      p.conditions.duration,
    ]),
    [[92, 120]],
  );
  assert.deepEqual(
    values(of("rolls-battery-hl12-580wagm").properties, "battery.voltage.nominal").map((p) => [
      p.values,
      p.unit,
    ]),
    [[[12], "V"]],
  );
});

test("Millertech: a pack's voltage, energy and five-second discharge current, a '.281KWH' energy read as one, and the 16V charger's output amps", () => {
  const pack = of("millertech-12v-100ah-lifepo4-millertech-battery");
  assert.deepEqual(
    values(pack.properties, "battery.voltage.nominal").map((p) => p.values),
    [[12.8]],
  );
  assert.deepEqual(
    values(pack.properties, "battery.energy").map((p) => p.value),
    [1280],
  );
  assert.deepEqual(
    values(pack.properties, "battery.discharge.current.peak").map((p) => [
      p.value,
      p.conditions.duration,
    ]),
    [[300, 5]],
  );
  assert.deepEqual(
    values(of("millertech-12v-22ah-lifepo4-millertech-battery").properties, "battery.energy").map(
      (p) => p.value,
    ),
    [281],
  );
  assert.deepEqual(
    values(of("millertech-16v-15a").properties, "charge.current.max").map((p) => p.value),
    [15],
  );
  // The two-bank charger's 'OUTPUT CURRENT 1' and '2' are each one bank's and are not read.
  assert.equal(values(of("millertech-12v10a-24v15a").properties, "charge.current.max").length, 0);
});

test("BSLBatt: the HVS stack's 'Nominal Capacity' in kilowatt-hours is its energy, and the usable figure beside it is not read", () => {
  const { properties, gaps } = of("bslbatt-hvs5");
  assert.deepEqual(
    values(properties, "battery.energy").map((p) => [p.value, p.unit, p.claim]),
    [[26625, "Wh", "bslbatt-hvs5--nominal-capacity"]],
  );
  assert.equal(gap(gaps, "battery.capacity")?.claims, 0);
});

test("Sigineer: the ESF's open-circuit limit, charge amps and PV power at four bank voltages, the LFP pack's 51.2 V over its 48 V class, and its peak without a time as a gap", () => {
  const esf = of("sigineer-esf48h80");
  assert.deepEqual(
    values(esf.properties, "pv.voc.max").map((p) => p.value),
    [250],
  );
  assert.deepEqual(
    values(esf.properties, "charge.current.max").map((p) => p.value),
    [80],
  );
  assert.deepEqual(
    values(esf.properties, "pv.power.max").map((p) => [p.value, p.conditions.bankVoltage]),
    [
      [1040, 12],
      [2080, 24],
      [3120, 36],
      [4160, 48],
    ],
  );
  const pack = of("sigineer-lfp-m48105h2");
  assert.deepEqual(
    values(pack.properties, "battery.voltage.nominal").map((p) => p.values),
    [[51.2]],
  );
  assert.deepEqual(
    values(pack.properties, "battery.charge.current.max").map((p) => p.value),
    [50],
  );
  assert.deepEqual(
    values(pack.properties, "battery.discharge.current.max").map((p) => p.value),
    [100],
  );
  assert.equal(gap(pack.gaps, "battery.discharge.current.peak")?.reason, "needs-conditions");
  assert.deepEqual(
    values(of("sigineer-m48120").properties, "charge.current.max").map((p) => p.value),
    [120],
  );
});

test("Champion: a generator's starting and running watts from one cell, by fuel, its tank in litres, its AC voltages, and a water pump's flow and head", () => {
  const dual = of("champion-power-201424");
  assert.deepEqual(
    values(dual.properties, "generator.power.starting").map((p) => [p.value, p.conditions.fuel]),
    [
      [11000, "lpg"],
      [11000, "natural-gas"],
      [11000, "gasoline"],
    ],
  );
  assert.deepEqual(
    values(dual.properties, "generator.power.running").map((p) => [p.value, p.conditions.fuel]),
    [
      [8100, "lpg"],
      [7290, "natural-gas"],
      [9000, "gasoline"],
    ],
  );
  assert.deepEqual(
    values(dual.properties, "inverter.voltage.ac").map((p) => p.values),
    [[120, 240]],
  );
  // The GB225 manual calls its gasoline cell 'Manual Watts'; on that manual it is read as such.
  assert.deepEqual(
    values(of("champion-power-gb225bt-2").properties, "generator.power.running")
      .map((p) => [p.conditions.fuel ?? "", p.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["gasoline", 4000],
      ["lpg", 3600],
      ["natural-gas", 3240],
    ],
  );
  const standby = of("champion-power-100304");
  assert.deepEqual(
    values(standby.properties, "generator.power.running").map((p) => [p.value, p.conditions.fuel]),
    [
      [22000, "lpg"],
      [19800, "natural-gas"],
    ],
  );
  assert.deepEqual(
    values(of("champion-power-201154").properties, "generator.fuel.tank").map((p) => [
      p.value,
      p.unit,
      p.conditions.fuel,
    ]),
    [[8.517176514, "L", "gasoline"]],
  );
  // A bare '5' under 'Gasoline Capacity' is gallons on the US sheet, as the rule says.
  assert.deepEqual(
    values(of("champion-power-201445").properties, "generator.fuel.tank").map((p) => p.value),
    [18.92705892],
  );
  const pump = of("champion-power-100113");
  assert.deepEqual(
    values(pump.properties, "pump.flow.rated").map((p) => [p.value, p.unit]),
    [[598.0950619, "L/min"]],
  );
  assert.deepEqual(
    values(pump.properties, "pump.head.max").map((p) => [p.value, p.unit]),
    [[29.8704, "m"]],
  );
  // Its engine's 'Fuel Capacity' is not a generator's tank: the key's kinds keep it out.
  assert.equal(values(pump.properties, "generator.fuel.tank").length, 0);
  // The bare engines and the transfer switches filed as generators are reviewed out of scope, so
  // an engine's tank and a switch's voltage are nobody's generator's.
  for (const other of [
    "champion-power-224cc-ohv-cpe",
    "champion-power-r210p",
    "champion-power-201020",
    "champion-power-201039",
  ])
    assert.equal(of(other).properties.length, 0, other);
  // The YF172FD and R420N tables were the 201076's and 201177's own manuals naming their engines:
  // the designations are aliases now and the tanks are the generators'.
  assert.deepEqual(
    values(of("champion-power-201076").properties, "generator.fuel.tank").map((p) => p.value),
    [17.79143538],
  );
  assert.deepEqual(
    values(of("champion-power-201177").properties, "generator.fuel.tank").map((p) => p.value),
    [20.17624481],
  );
  // Victron's Skylla-TG prints 'Battery capacity' as the banks it is for; that is Victron's own rule.
  const skylla = values(of("victron-energy-skylla-tg-48-25").properties, "charge.battery.capacity");
  assert.deepEqual(
    skylla.map((p) => [p.min, p.max]),
    [[125, 250]],
  );
  assert.ok(own("victron-energy", skylla));
  // Xantrex's Freedom XC recommends one size, 100 Ah, which is the scalar key's; its '100 Ah or more' is a bound.
  assert.deepEqual(
    values(of("xantrex-freedom-xc").properties, "charge.battery.capacity.recommended").map((p) => [
      p.value,
      p.unit,
    ]),
    [[100, "Ah"]],
  );
  assert.equal(
    gap(of("xantrex-freedom-xc-1800-12vdc").gaps, "charge.battery.capacity.recommended")?.reason,
    "unparsed",
  );
});

test("Pentair: a plunger pump's pressure in bar and its horsepower in watts, a fractional horsepower, a bare 'Flow rate' under its own rule, the MES sheet's 'Capacity' read on that sheet only, and the filters out of scope", () => {
  const plunger = of("pentair-ma-240l-hd");
  assert.deepEqual(
    values(plunger.properties, "pump.pressure.max").map((p) => [p.value, p.unit]),
    [[70.11968164, "bar"]],
  );
  assert.deepEqual(
    values(of("pentair-ma-15h").properties, "pump.power.rated").map((p) => [p.value, p.unit]),
    [[11185.49807, "W"]],
  );
  // The Everpure filters that printed a service flow are reviewed out of scope: a cartridge moves no water.
  assert.equal(of("pentair-ev9337-44").properties.length, 0);
  // '1/2' under 'HP' and '4/10' under 'Motor HP' are fractions of a horsepower, not two figures.
  assert.deepEqual(
    values(of("pentair-ms50pt").properties, "pump.power.rated").map((p) => [p.value, p.unit]),
    [[372.8499358, "W"]],
  );
  assert.deepEqual(
    values(of("pentair-shef42a1").properties, "pump.power.rated").map((p) => p.value),
    [298.2799486],
  );
  // 'Flow rate' is Pentair's own rule, not the shared mapping's.
  const flow = values(of("pentair-b4zrks").properties, "pump.flow.rated");
  assert.deepEqual(
    flow.map((p) => [p.value, p.conditions.head]),
    [[1703.435303, 28.956]],
  );
  // The SB24VRS sheet's shut-off head, printed with its feet on one package and bare on the other.
  assert.deepEqual(
    values(of("pentair-sb24vrs1021").properties, "pump.head.max").map((p) => p.value),
    [18.288],
  );
  // Its sibling prints '60’ (18.6 m)', a conversion off by 1.7 %, which the parser refuses as it should.
  assert.match(
    gap(of("pentair-sb24vrs10").gaps, "pump.head.max")?.detail ?? "",
    /changes the figure/,
  );
  assert.ok(own("pentair", flow));
  // The SHEF42's curve: one flow at each head, from the column names, kept apart by the height.
  assert.deepEqual(
    values(of("pentair-shef42a1").properties, "pump.flow.rated")
      .map((p) => [p.value, p.conditions.head ?? 0])
      .sort((a, b) => a[1] - b[1]),
    [
      [230.9101188, 1.524],
      [196.8414128, 3.048],
      [170.3435303, 4.572],
      [143.8456478, 6.096],
      [113.5623535, 7.62],
      [79.49364746, 9.144],
    ],
  );
  const mes = values(of("pentair-mes50").properties, "pump.flow.rated");
  assert.deepEqual(
    mes.map((p) => p.value),
    [238.4809424],
  );
  assert.ok(own("pentair", mes));
  // On a filter sheet 'Capacity' is gallons of service life, which the source-scoped rule leaves alone.
  assert.equal(of("pentair-7fc5-s").properties.length, 0);
  // The Fleck flow controls are restrictors, out of scope: 'Flow rate' reads the B4ZRKS sheet only.
  assert.equal(of("pentair-blfc-assy-1-2-12-gpm").properties.length, 0);
  // The HPGR200 is a grinder pump filed as a generator: reviewed as a pump, its 'Full Load kW' is
  // its motor's load and reads under no generator key, and its 2 HP reads under the pump's.
  assert.equal(values(of("pentair-hpgr200").properties, "generator.power.running").length, 0);
  assert.deepEqual(
    values(of("pentair-hydromatic-hpgr200").properties, "pump.power.rated").map((p) => p.value),
    [1491.399743],
  );
});

test("NOCO's chargers: the output watts, the battery sizes as a range, and a bound as the gap it is", () => {
  assert.deepEqual(
    values(of("noco-gen5x1").properties, "charge.power.max").map((p) => [p.value, p.unit]),
    [[72, "W"]],
  );
  assert.deepEqual(
    values(of("noco-gx3626").properties, "charge.battery.capacity").map((p) => [p.min, p.max]),
    [[55, 425]],
  );
  // The record minted under the maker's own name is out of scope: its figures are other models'.
  assert.equal(of("noco-noco").properties.length, 0);
  const genius = of("noco-genius2");
  assert.equal(gap(genius.gaps, "charge.battery.capacity")?.reason, "unparsed");
  assert.match(gap(genius.gaps, "charge.battery.capacity")?.detail ?? "", /bound/);
});

test("OutBack's VA figures reach the apparent-power keys through the watt rules that name them", () => {
  const { properties, gaps } = of("outback-power-fx2012t");
  assert.deepEqual(
    values(properties, "inverter.power.apparent").map((p) => [p.value, p.unit]),
    [[2000, "VA"]],
  );
  assert.ok(
    values(properties, "inverter.power.apparent").every((p) =>
      p.mappedBy.startsWith("rule:shared@"),
    ),
  );
  assert.deepEqual(
    values(properties, "inverter.power.apparent.surge").map((p) => [
      p.value,
      p.conditions.duration,
    ]),
    [
      [2500, 1800],
      [4000, 5],
    ],
  );
  // The bare 'AC Overload Capability - Surge' states no time and stays the sibling's gap.
  assert.deepEqual(gap(gaps, "inverter.power.apparent.surge"), {
    model: "outback-power-fx2012t",
    key: "inverter.power.apparent.surge",
    reason: "needs-conditions",
    detail: "no duration stated, beside 2 usable figures",
    claims: 3,
  });
  // The watt keys were never claimed by those figures.
  assert.equal(gap(gaps, "inverter.power.continuous")?.reason, "no-claim");
  assert.equal(gap(gaps, "inverter.power.surge")?.reason, "no-claim");
});

test("a Luxpower rating printed as '6KVA/6KW' reaches both the watt key and its VA sibling", () => {
  const { properties } = of("luxpower-sna-us-600033");
  assert.deepEqual(
    values(properties, "inverter.power.continuous").map((p) => [p.value, p.claim]),
    [[6000, "luxpower-sna-us-600033--rated-output-power"]],
  );
  assert.deepEqual(
    values(properties, "inverter.power.apparent").map((p) => [p.value, p.claim]),
    [[6000, "luxpower-sna-us-600033--rated-output-power"]],
  );
  // Magnum's '4000 VA (L-L)' is the apparent key's value now, not the watt key's.
  const ms = of("magnum-energy-ms4024pae");
  assert.deepEqual(
    values(ms.properties, "inverter.power.apparent").map((p) => p.value),
    [4000],
  );
  assert.equal(gap(ms.gaps, "inverter.power.continuous")?.reason, "no-claim");
});

test("the Victron MPPT 250/60, a charge controller, publishes its PV power at all four bank voltages", () => {
  const { properties, gaps } = of("victron-energy-mppt-250-60");
  assert.deepEqual(
    values(properties, "pv.power.max").map((p) => [p.value, p.conditions.bankVoltage]),
    [
      [860, 12],
      [1720, 24],
      [2580, 36],
      [3440, 48],
    ],
  );
  assert.equal(gap(gaps, "pv.power.max"), undefined);
});

test("a lithium pack's capacity publishes without a rate, a lead-acid pack's with the rate its sheet names", () => {
  const lfp = of("millertech-12v-100ah-lifepo4-millertech-battery");
  assert.deepEqual(
    values(lfp.properties, "battery.capacity").map((p) => [p.value, p.conditions]),
    [[100, {}]],
  );
  const agm = of("rolls-battery-hl12-580wagm");
  assert.deepEqual(
    values(agm.properties, "battery.capacity").map((p) => [p.value, p.conditions.dischargeHours]),
    [
      [145, 10],
      [155, 20],
    ],
  );
});

import { z } from "zod";
import { EquipmentKind } from "./guess.ts";
import { BatteryChemistry } from "./model.ts";

/**
 * The registry of normalized properties: one canonical key per figure a consumer needs as a
 * number under one name, whatever the maker printed it as.
 *
 * A controller's PV open-circuit limit appears in the released figures under 53 names, from
 * "Max. input voltage" to "Maximum Solar Input Voltage", and twelve of those are not numbers
 * ("150 volts DC"). Every printed figure stays exactly as it is in `specs`; a property is a
 * validated reading of one of them under a key from this list (#82).
 */

/** What a property measures. A unit belongs to one quantity, and a key accepts only its own. */
export const Quantity = z.enum([
  "voltage",
  "current",
  "power",
  "apparent-power",
  "energy",
  "charge",
  "temperature",
  /** Change per kelvin of a rated figure: a panel's Voc falls 0.25 % for each degree warmer. */
  "temperature-coefficient",
  "time",
  /** A tank, in litres. */
  "volume",
  /** What a pump moves, in litres a minute. */
  "flow",
  /** What a pump works against, in bar. */
  "pressure",
  /** A pump's head, in metres. */
  "length",
]);
export type Quantity = z.infer<typeof Quantity>;

/** The one unit each property is published in. What a maker printed is converted, never guessed. */
export const CanonicalUnit = z.enum([
  "V",
  "A",
  "W",
  "VA",
  "Wh",
  "Ah",
  "°C",
  "%/K",
  "s",
  "L",
  "L/min",
  "bar",
  "m",
]);
export type CanonicalUnit = z.infer<typeof CanonicalUnit>;

/**
 * What a figure is true under. A capacity without its discharge rate is not a capacity, and a
 * surge rating without its duration is a number with no meaning; a key says which of these it
 * needs, and a property that cannot say them is a gap, not a value.
 */
export const ConditionKey = z.enum([
  /** Standard test conditions: 1000 W/m², 25 °C cell temperature, AM 1.5. */
  "stc",
  /** °C. */
  "cellTemperature",
  /** °C. */
  "ambientTemperature",
  /** V, the battery bank the figure is for: a controller's PV power limit differs at 12 V and 24 V. */
  "bankVoltage",
  /** h, the discharge rate a capacity is stated at: C20 is 20. */
  "dischargeHours",
  /** s, how long a surge or peak figure holds. */
  "duration",
  /** The operating mode an idle figure is for, as printed: "search", "invert, no load". */
  "mode",
  /** The fuel a generator's figure is for: "gasoline", "lpg", "natural-gas", "diesel". Dual-fuel sets rate each. */
  "fuel",
  /** %, the share of rated load a generator's run time or consumption is stated at. */
  "load",
  /** m, the head a pump's flow is stated at: a curve's points are one flow at each height. */
  "head",
  /** What the parser could not structure, kept as text so nothing is thrown away. */
  "note",
]);
export type ConditionKey = z.infer<typeof ConditionKey>;

/** The live reading a property is a limit on, so a check can compare the two by name. */
export const Reading = z.enum([
  "pv-voltage",
  "pv-current",
  "pv-power",
  "battery-voltage",
  "battery-current",
  "ac-output-power",
]);
export type Reading = z.infer<typeof Reading>;

/** How a property's value is shaped: one number, a range, or a set of alternatives. */
export const Shape = z.enum(["scalar", "range", "set"]);
export type Shape = z.infer<typeof Shape>;

/** The conditions a property's value holds under, structured. Each key is one of `ConditionKey`. */
export const Conditions = z
  .object({
    stc: z.literal(true).optional(),
    cellTemperature: z.number().optional(),
    ambientTemperature: z.number().optional(),
    bankVoltage: z.number().positive().optional(),
    dischargeHours: z.number().positive().optional(),
    duration: z.number().positive().optional(),
    mode: z.string().min(1).optional(),
    fuel: z.enum(["gasoline", "lpg", "natural-gas", "diesel"]).optional(),
    load: z.number().positive().max(100).optional(),
    head: z.number().positive().optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type Conditions = z.infer<typeof Conditions>;

/**
 * What a property rests on, derived from its claim's columns and never from a mapping rule: a
 * rule is not a review. `reviewed` when a person confirmed the figure, `extracted` when only a
 * reader took it from the document, `feed` for a row a public dataset states.
 */
export const Basis = z.enum(["reviewed", "extracted", "feed"]);
export type Basis = z.infer<typeof Basis>;

/** Why a model has no usable value under a key. A consumer sees the reason, not an absence. */
export const GapReason = z.enum(["no-claim", "unparsed", "needs-conditions", "conflict"]);
export type GapReason = z.infer<typeof GapReason>;

/** Whether a property row is a usable value or one of two that disagree; `properties.status`. */
export const PropertyStatus = z.enum(["value", "conflict"]);
export type PropertyStatus = z.infer<typeof PropertyStatus>;

/** Whether a figure is per input or for the whole unit; `properties.scope`. */
export const PropertyScope = z.enum(["per-input", "total"]);
export type PropertyScope = z.infer<typeof PropertyScope>;

export const Property = z
  .object({
    /** Dotted, lowest-level last: `pv.voc.max`. */
    key: z.string().regex(/^[a-z]+(\.[a-z]+)+$/),
    quantity: Quantity,
    unit: CanonicalUnit,
    shape: Shape,
    /** The kinds of equipment the key applies to. A battery has no MPPT window. */
    kinds: z.array(EquipmentKind).min(1),
    /** Conditions a value must state to be usable. */
    needs: z.array(ConditionKey).default([]),
    /**
     * Conditions in `needs` a model of one of these chemistries does without: a lithium pack's
     * capacity stands without a discharge rate, a lead-acid pack's does not. A model whose
     * chemistry is not recorded waives nothing.
     */
    waivedFor: z
      .object({
        chemistry: z.array(BatteryChemistry).min(1),
        conditions: z.array(ConditionKey).min(1),
      })
      .strict()
      .optional(),
    /** Conditions a value may state and a consumer should read. */
    accepts: z.array(ConditionKey).default([]),
    /** The reading this property bounds, when it is a limit. */
    limits: Reading.optional(),
    /**
     * Whether the figure is per input or for the whole unit, where a device has several MPPT
     * inputs and a maker prints either without saying. Absent where the question does not arise.
     */
    scope: PropertyScope.optional(),
    /**
     * The key a figure named under this one is read under when the sheet prints it as apparent
     * power: a "Continuous output power" of 3000 VA is not a gap on the watt key but a value on
     * its VA sibling, with the same conditions and the same rule.
     */
    apparent: z
      .string()
      .regex(/^[a-z]+(\.[a-z]+)+$/)
      .optional(),
    description: z.string().min(1),
  })
  .strict();
export type Property = z.infer<typeof Property>;

const controllers: EquipmentKind[] = ["charge-controller", "inverter", "inverter-charger"];
const inverters: EquipmentKind[] = ["inverter", "inverter-charger"];
/** What charges a battery from something other than PV: a mains charger, a DC-DC converter, a controller's or an inverter-charger's charger. */
const chargers: EquipmentKind[] = [
  "ac-charger",
  "dc-dc-converter",
  "charge-controller",
  "inverter-charger",
];

/**
 * The first keys: what the first setup checks read. PV limits and the MPPT window for anything
 * with a PV input, a panel's STC figures and coefficients, a battery's capacity and current
 * limits, and an inverter's continuous, surge and idle power.
 */
export const PROPERTIES: Property[] = [
  {
    key: "pv.voc.max",
    quantity: "voltage",
    unit: "V",
    shape: "scalar",
    kinds: controllers,
    needs: [],
    accepts: ["cellTemperature", "ambientTemperature"],
    limits: "pv-voltage",
    scope: "per-input",
    description: "Highest PV open-circuit voltage the input may see, at any temperature.",
  },
  {
    key: "pv.isc.max",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: controllers,
    needs: [],
    accepts: [],
    limits: "pv-current",
    scope: "per-input",
    description: "Highest PV short-circuit current the input may see.",
  },
  {
    key: "pv.power.max",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: controllers,
    needs: [],
    accepts: ["bankVoltage"],
    limits: "pv-power",
    scope: "total",
    description: "Most PV power the unit uses, which for a controller depends on the bank voltage.",
  },
  {
    key: "pv.mppt.window",
    quantity: "voltage",
    unit: "V",
    shape: "range",
    kinds: controllers,
    needs: [],
    accepts: ["bankVoltage"],
    scope: "per-input",
    description: "PV voltage range the tracker works over.",
  },
  {
    key: "battery.voltage.nominal",
    quantity: "voltage",
    unit: "V",
    shape: "set",
    kinds: [...controllers, "battery", "ac-charger", "dc-dc-converter", "bms", "shunt-monitor"],
    needs: [],
    accepts: [],
    description: "Nominal bank voltages the unit is made for, or a battery's own.",
  },
  {
    key: "charge.current.max",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: [...controllers, "ac-charger", "dc-dc-converter"],
    needs: [],
    accepts: ["bankVoltage", "ambientTemperature"],
    limits: "battery-current",
    scope: "total",
    description:
      "Highest charge current the unit delivers to the battery, at the ambient temperature the sheet states it for where it states one.",
  },
  {
    key: "panel.power.stc",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: ["panel"],
    needs: ["stc"],
    accepts: [],
    description: "Nameplate power at standard test conditions.",
  },
  {
    key: "panel.voc.stc",
    quantity: "voltage",
    unit: "V",
    shape: "scalar",
    kinds: ["panel"],
    needs: ["stc"],
    accepts: [],
    description: "Open-circuit voltage at standard test conditions.",
  },
  {
    key: "panel.isc.stc",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: ["panel"],
    needs: ["stc"],
    accepts: [],
    description: "Short-circuit current at standard test conditions.",
  },
  {
    key: "panel.vmp.stc",
    quantity: "voltage",
    unit: "V",
    shape: "scalar",
    kinds: ["panel"],
    needs: ["stc"],
    accepts: [],
    description: "Voltage at maximum power, at standard test conditions.",
  },
  {
    key: "panel.imp.stc",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: ["panel"],
    needs: ["stc"],
    accepts: [],
    description: "Current at maximum power, at standard test conditions.",
  },
  {
    key: "panel.voc.coefficient",
    quantity: "temperature-coefficient",
    unit: "%/K",
    shape: "scalar",
    kinds: ["panel"],
    needs: [],
    accepts: [],
    description: "Change in open-circuit voltage per kelvin, as a share of the STC figure.",
  },
  {
    key: "panel.isc.coefficient",
    quantity: "temperature-coefficient",
    unit: "%/K",
    shape: "scalar",
    kinds: ["panel"],
    needs: [],
    accepts: [],
    description: "Change in short-circuit current per kelvin, as a share of the STC figure.",
  },
  {
    key: "panel.power.coefficient",
    quantity: "temperature-coefficient",
    unit: "%/K",
    shape: "scalar",
    kinds: ["panel"],
    needs: [],
    accepts: [],
    description: "Change in maximum power per kelvin, as a share of the STC figure.",
  },
  {
    key: "battery.capacity",
    quantity: "charge",
    unit: "Ah",
    shape: "scalar",
    kinds: ["battery"],
    needs: ["dischargeHours"],
    waivedFor: { chemistry: ["lifepo4", "lithium"], conditions: ["dischargeHours"] },
    accepts: ["ambientTemperature"],
    description:
      "Capacity at a stated discharge rate: 428 Ah at C20 and 556 Ah at C100 are two values. A lithium pack's capacity stands without one.",
  },
  {
    key: "battery.energy",
    quantity: "energy",
    unit: "Wh",
    shape: "scalar",
    kinds: ["battery"],
    needs: [],
    accepts: ["dischargeHours"],
    description: "Nominal energy, as makers of lithium packs state it.",
  },
  {
    key: "battery.charge.current.max",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: ["battery"],
    needs: [],
    accepts: ["ambientTemperature"],
    limits: "battery-current",
    description: "Highest continuous charge current the battery accepts.",
  },
  {
    key: "battery.discharge.current.max",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: ["battery"],
    needs: [],
    accepts: ["ambientTemperature"],
    limits: "battery-current",
    description: "Highest continuous discharge current the battery delivers.",
  },
  {
    key: "battery.discharge.current.peak",
    quantity: "current",
    unit: "A",
    shape: "scalar",
    kinds: ["battery"],
    needs: ["duration"],
    accepts: [],
    limits: "battery-current",
    description: "Highest discharge current the battery delivers for a stated time.",
  },
  {
    key: "inverter.power.continuous",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: inverters,
    needs: [],
    accepts: ["ambientTemperature"],
    limits: "ac-output-power",
    apparent: "inverter.power.apparent",
    description: "Continuous AC output power.",
  },
  {
    key: "inverter.power.apparent",
    quantity: "apparent-power",
    unit: "VA",
    shape: "scalar",
    kinds: inverters,
    needs: [],
    accepts: ["ambientTemperature"],
    description:
      "Continuous AC output as apparent power, where the sheet rates it in VA rather than watts.",
  },
  {
    key: "inverter.power.surge",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: inverters,
    needs: ["duration"],
    accepts: [],
    limits: "ac-output-power",
    apparent: "inverter.power.apparent.surge",
    description: "AC output power the inverter holds for a stated time.",
  },
  {
    key: "inverter.power.apparent.surge",
    quantity: "apparent-power",
    unit: "VA",
    shape: "scalar",
    kinds: inverters,
    needs: ["duration"],
    accepts: [],
    description:
      "Apparent power the inverter holds for a stated time, where the sheet rates it in VA.",
  },
  {
    key: "inverter.power.idle",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: inverters,
    needs: [],
    accepts: ["mode"],
    description: "Power the inverter draws from the battery with no load.",
  },
  {
    key: "inverter.voltage.ac",
    quantity: "voltage",
    unit: "V",
    shape: "set",
    kinds: [...inverters, "generator"],
    needs: [],
    accepts: [],
    description: "Nominal AC output voltages.",
  },
  // ---- chargers (#126): what a mains or DC charger puts out, and the banks it is for
  {
    key: "charge.power.max",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: chargers,
    needs: [],
    accepts: ["bankVoltage"],
    description:
      "Most power a charger delivers to the battery, which for a multi-voltage charger depends on the bank.",
  },
  {
    key: "charge.battery.capacity",
    quantity: "charge",
    unit: "Ah",
    shape: "range",
    kinds: chargers,
    needs: [],
    accepts: [],
    description: "The battery sizes a charger is made for, as the maker states them.",
  },
  {
    key: "charge.battery.capacity.recommended",
    quantity: "charge",
    unit: "Ah",
    shape: "scalar",
    kinds: chargers,
    needs: [],
    accepts: [],
    description:
      "The one battery size a charger's maker recommends, where the sheet gives a figure rather than a range.",
  },
  // ---- generators (#126): what a generator makes and what it burns
  {
    key: "generator.power.running",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: ["generator"],
    needs: [],
    accepts: ["fuel"],
    description: "Power a generator sustains, by fuel where a dual-fuel set rates each.",
  },
  {
    key: "generator.power.starting",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: ["generator"],
    needs: [],
    accepts: ["fuel"],
    description:
      "Power a generator gives for the seconds a motor takes to start, by fuel where a dual-fuel set rates each.",
  },
  {
    key: "generator.fuel.tank",
    quantity: "volume",
    unit: "L",
    shape: "scalar",
    kinds: ["generator"],
    needs: [],
    accepts: ["fuel"],
    description: "What the generator's tank holds.",
  },
  // ---- pumps (#126): what a pump moves and works against
  {
    key: "pump.flow.rated",
    quantity: "flow",
    unit: "L/min",
    shape: "scalar",
    kinds: ["pump"],
    needs: [],
    accepts: ["head"],
    description:
      "The flow a pump is rated at, in litres a minute, at the head the sheet states it for where it gives a curve.",
  },
  {
    key: "pump.head.max",
    quantity: "length",
    unit: "m",
    shape: "scalar",
    kinds: ["pump"],
    needs: [],
    accepts: [],
    description: "The height of water a pump can lift against, at which its flow is nothing.",
  },
  {
    key: "pump.pressure.max",
    quantity: "pressure",
    unit: "bar",
    shape: "scalar",
    kinds: ["pump"],
    needs: [],
    accepts: [],
    description: "The most pressure a pump works at continuously.",
  },
  {
    key: "pump.power.rated",
    quantity: "power",
    unit: "W",
    shape: "scalar",
    kinds: ["pump"],
    needs: [],
    accepts: [],
    description: "The power a pump's motor is rated at; horsepower is converted.",
  },
];

/** The registry by key, for a rule or a consumer that has one. */
export const PROPERTY_BY_KEY: ReadonlyMap<string, Property> = new Map(
  PROPERTIES.map((property) => [property.key, property]),
);

import type { ConditionKey, Conditions } from "@origin89/equipment-schema/properties";

/**
 * What a figure is true under, read out of the words around it.
 *
 * Makers put the condition in the name ("Max. PV Power 24Vdc", "Cont. output power at 25°C",
 * "30 sec Surge Power", "Capacity at 10 Hour Rate"), in a conditions field ("C20"), or in the
 * value itself ("145 A / 2 mins"). A property needs some of them and may carry others, so only
 * the conditions a key accepts are read: a bank voltage in the name of a figure that has no
 * bank voltage is a number that means something else.
 */

/** Bank voltages a maker states a figure for. Anything else in the name is not one. */
const BANKS = new Set([12, 24, 36, 48, 96]);

const SECONDS: Record<string, number> = {
  ms: 0.001,
  msec: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
};

const number = (text: string): number => Number(text.replace(",", "."));

/** What a sheet calls each fuel, as the condition names it. */
const FUELS: Record<string, Conditions["fuel"]> = {
  "natural gas": "natural-gas",
  ng: "natural-gas",
  lpg: "lpg",
  propane: "lpg",
  gasoline: "gasoline",
  gas: "gasoline",
  petrol: "gasoline",
  diesel: "diesel",
};

/** The conditions a text states among those asked for. */
export function conditionsFrom(text: string, accepts: readonly ConditionKey[]): Conditions {
  const out: Conditions = {};
  const wanted = new Set(accepts);
  if (wanted.has("stc") && /\bSTC\b/i.test(text)) out.stc = true;
  if (wanted.has("dischargeHours")) {
    const rate =
      /\bC\s?(\d{1,3})\b/.exec(text) ?? /(\d{1,3})\s*-?\s*(?:hour|hr|h)\b[\s-]*rate/i.exec(text);
    if (rate?.[1]) out.dischargeHours = Number(rate[1]);
  }
  if (wanted.has("cellTemperature") || wanted.has("ambientTemperature")) {
    const celsius = /(-?\d{1,3}(?:[.,]\d+)?)\s*(?:°\s*C|℃)\b/.exec(text);
    const fahrenheit = /(-?\d{1,3}(?:[.,]\d+)?)\s*°\s*F\b/.exec(text);
    const degrees = celsius?.[1]
      ? number(celsius[1])
      : fahrenheit?.[1]
        ? Number((((number(fahrenheit[1]) - 32) * 5) / 9).toFixed(1))
        : undefined;
    if (degrees !== undefined) {
      // A panel's figures are at a cell temperature; everything else is the air around the unit.
      if (wanted.has("cellTemperature") && /\bcell\b/i.test(text)) out.cellTemperature = degrees;
      else if (wanted.has("ambientTemperature")) out.ambientTemperature = degrees;
      else out.cellTemperature = degrees;
    }
  }
  if (wanted.has("bankVoltage")) {
    for (const match of text.matchAll(/(\d{2,3})\s*V(?:dc)?\b/gi)) {
      const volts = Number(match[1]);
      if (BANKS.has(volts)) {
        out.bankVoltage = volts;
        break;
      }
    }
  }
  if (wanted.has("duration")) {
    const held =
      /(\d+(?:[.,]\d+)?)\s*(ms|msec|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?)\b/i.exec(text);
    const unit = held?.[2]?.toLowerCase();
    if (held?.[1] && unit && SECONDS[unit] !== undefined)
      out.duration = Number((number(held[1]) * SECONDS[unit]).toPrecision(10));
  }
  if (wanted.has("mode")) {
    const mode = /\b(search|invert|standby|night|sleep|eco)\b/i.exec(text);
    if (mode?.[1]) out.mode = mode[1].toLowerCase();
  }
  if (wanted.has("fuel")) {
    // "gas" is gasoline on a North American sheet; natural gas is named as such or as NG.
    const fuel = /\b(natural gas|NG|LPG|propane|gasoline|gas|petrol|diesel)\b/i.exec(text)?.[1];
    if (fuel) out.fuel = FUELS[fuel.toLowerCase()];
  }
  if (wanted.has("load")) {
    const load = /(\d{1,3})\s*%\s*(?:of\s+)?(?:rated\s+)?load\b/i.exec(text);
    const share = load?.[1] ? Number(load[1]) : undefined;
    if (share !== undefined && share > 0 && share <= 100) out.load = share;
  }
  return out;
}

/**
 * A duration a maker prints inside the value: "145 A / 2 mins", "32A for 1s". The figure is the
 * part before it, and the time is the condition it holds for.
 */
export function splitDuration(value: string): { value: string; duration?: number } {
  const match =
    /^(.*?\S)\s*(?:\/|for|@|during)\s*(\d+(?:[.,]\d+)?)\s*(ms|msec|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?)\s*$/i.exec(
      value.trim(),
    );
  const unit = match?.[3]?.toLowerCase();
  if (!match?.[1] || !match[2] || !unit || SECONDS[unit] === undefined) return { value };
  return {
    value: match[1],
    duration: Number((number(match[2]) * SECONDS[unit]).toPrecision(10)),
  };
}

/** Conditions stated by a rule, then by the figure's own words; the figure's win where both speak. */
export function mergeConditions(...layers: (Conditions | undefined)[]): Conditions {
  const out: Conditions = {};
  for (const layer of layers) Object.assign(out, layer ?? {});
  return out;
}

/** The same conditions in the same order, so two figures under them group together. */
export function conditionsKey(conditions: Conditions): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(conditions)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/**
 * What counts as a unit, and what a document's own language calls it.
 *
 * A figure whose unit is "ACCEPTABLE" or "STC" is not a figure with an unusual unit; it is a
 * reader that put something else in the unit field. And a Spanish datasheet writes VCD for volts
 * and pulgadas for inches, which are the same units under different names — losing them would
 * throw away real figures, and keeping them unmapped would mean two names for one quantity.
 */

/** The units this database publishes, each meaning one quantity. */
export const UNITS = [
  "V", "A", "W", "VA", "Ah", "Wh", "kW", "kWh", "kVA", "mV", "mA", "mAh", "Hz", "Ω",
  "°C", "°F", "%", "kg", "g", "lb", "mm", "cm", "m", "in", "ft", "m²", "L", "gal",
  "min", "h", "s", "dB", "bar", "psi", "kPa", "cycles",
] as const;
export type Unit = (typeof UNITS)[number];

/** What makers write instead. Spanish and French datasheets are common in this trade. */
const ALIASES: Record<string, Unit> = {
  v: "V", vdc: "V", vac: "V", vcd: "V", vca: "V", volt: "V", volts: "V", voltios: "V",
  a: "A", adc: "A", aac: "A", amp: "A", amps: "A", amperes: "A", amperios: "A",
  w: "W", watt: "W", watts: "W", vatios: "W", va: "VA", kva: "kVA",
  ah: "Ah", amphours: "Ah", "amp-hours": "Ah", wh: "Wh", kwh: "kWh", kw: "kW",
  mv: "mV", ma: "mA", mah: "mAh", hz: "Hz", ohm: "Ω", ohms: "Ω",
  c: "°C", "°c": "°C", celsius: "°C", f: "°F", "°f": "°F",
  "%": "%", pct: "%", kg: "kg", kgs: "kg", g: "g", lb: "lb", lbs: "lb", libras: "lb",
  mm: "mm", cm: "cm", m: "m", in: "in", inch: "in", inches: "in", pulgadas: "in", pouces: "in",
  ft: "ft", feet: "ft", m2: "m²", "m^2": "m²", l: "L", litres: "L", liters: "L", gal: "gal",
  min: "min", mins: "min", minutes: "min", h: "h", hr: "h", hrs: "h", hours: "h",
  s: "s", sec: "s", seconds: "s", db: "dB", bar: "bar", psi: "psi", kpa: "kPa",
  cycles: "cycles", ciclos: "cycles",
};

/**
 * The unit a string means, or nothing. Nothing is the answer for "ACCEPTABLE", "STC" and "DC":
 * those are words that ended up in the unit field, and publishing them as units would make a
 * reader think the database has thirty different quantities when it has thirty-six.
 */
export function canonicalUnit(raw: string | undefined): Unit | undefined {
  const key = raw?.trim();
  if (!key) return undefined;
  if ((UNITS as readonly string[]).includes(key)) return key as Unit;
  return ALIASES[key.toLowerCase().replace(/\s+/g, "")];
}

/**
 * Pull a unit out of a value that has one glued on. A model told to put the unit in its own field
 * writes "57.6V" anyway, and twenty-two figures in one run did exactly that: the number is right
 * and the unit is right, and only the shape is wrong.
 */
export function splitValueUnit(value: string, unit: string | undefined): { value: string; unit?: string } {
  const canonical = canonicalUnit(unit);
  if (canonical) return { value: value.trim(), unit: canonical };
  const match = /^(-?\d+(?:[.,]\d+)?)\s*([A-Za-zΩ°µ%][A-Za-zΩ°µ%²³/·.]{0,9})$/.exec(value.trim());
  const pulled = match ? canonicalUnit(match[2]) : undefined;
  return pulled ? { value: match![1], unit: pulled } : { value: value.trim() };
}

/** Whether a value is a plain number, which is what a figure with a unit ought to be. */
export function isNumeric(value: string): boolean {
  return /^-?\d+([.,]\d+)?$/.test(value.trim());
}

/** Figures that are legitimately a bare number: a count is not a measurement and has no unit. */
const COUNTED = /\b(cells?|count|number|quantity|qty|series|parallel|stages?|ports?|outlets?|strings?|modules?|phases?)\b/i;

/** A value that reads as a sentence rather than a figure. */
function isProse(value: string): boolean {
  const text = value.trim();
  if (text.length > 40) return true;
  // "Default setting: 14.4V" and "10A (adjustable)" are a figure wrapped in an explanation. The
  // figure is in there; what is stored is not it.
  return /:\s/.test(text) || /\(.*\s.*\)/.test(text);
}

/**
 * Why a figure would not be trusted for sizing anything. Empty means it would.
 *
 * The first version of this missed the commonest problem entirely: a value that is a sentence
 * trips no rule about units, so eighty-seven per cent of model-extracted figures looked clean
 * while most of them were prose.
 */
export function concerns(spec: { value: string; unit?: string; name: string }): string[] {
  const out: string[] = [];
  if (spec.unit && !canonicalUnit(spec.unit)) out.push(`"${spec.unit}" is not a unit`);
  if (spec.unit && canonicalUnit(spec.unit) && !isNumeric(spec.value)) out.push("a figure with a unit whose value is not a number");
  if (!spec.unit && isNumeric(spec.value) && !COUNTED.test(spec.name)) out.push("a number with no unit, so what it measures is unstated");
  if (isProse(spec.value)) out.push("a sentence rather than a figure");
  return out;
}

/**
 * A value that is not a figure but a piece of the JSON it was read out of. Models write a curly
 * closing quote where JSON wants a straight one — `"tension nominale": "24 – 48”` — and the reader
 * then runs past the end of the string and swallows whatever punctuation follows, which is how a
 * Lorentz pump came to have a rated voltage of `24 & 48”}]}, {`.
 *
 * Refused rather than doubted: a doubtful figure is a number somebody can check, and this is not a
 * number at all. An inch mark is safe — `1/2.7", CMOS 2.1 MP` ends in a word, not in punctuation.
 */
export function looksTruncated(value: string): boolean {
  if (/[{}[\]]/.test(value)) return true;
  return /[,;]\s*$/.test(value);
}

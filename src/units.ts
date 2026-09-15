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
  "V",
  "A",
  "W",
  "VA",
  "Ah",
  "Wh",
  "kW",
  "kWh",
  "kVA",
  "mV",
  "mA",
  "mAh",
  "Hz",
  "Ω",
  "°C",
  "°F",
  "%",
  "kg",
  "g",
  "lb",
  "mm",
  "cm",
  "m",
  "in",
  "ft",
  "m²",
  "L",
  "gal",
  "qt",
  "L/min",
  "gpm",
  "m³/h",
  "hp",
  "min",
  "h",
  "s",
  "dB",
  "bar",
  "psi",
  "kPa",
  "cycles",
  // A temperature coefficient: how far a figure moves per kelvin. Per degree Celsius is the same
  // thing, since a difference of one is one on both scales, and makers write either. A charger's
  // compensation is stated in millivolts (#82).
  "A/K",
  "V/K",
  "mV/K",
  "%/K",
] as const;
export type Unit = (typeof UNITS)[number];

/** What each unit measures, so a figure can be refused for a unit outside its quantity. */
export const QUANTITY_OF: Record<Unit, string> = {
  V: "voltage",
  A: "current",
  W: "power",
  VA: "apparent-power",
  Ah: "charge",
  Wh: "energy",
  kW: "power",
  kWh: "energy",
  kVA: "apparent-power",
  mV: "voltage",
  mA: "current",
  mAh: "charge",
  Hz: "frequency",
  Ω: "resistance",
  "°C": "temperature",
  "°F": "temperature",
  "%": "ratio",
  kg: "mass",
  g: "mass",
  lb: "mass",
  mm: "length",
  cm: "length",
  m: "length",
  in: "length",
  ft: "length",
  "m²": "area",
  L: "volume",
  gal: "volume",
  qt: "volume",
  "L/min": "flow",
  gpm: "flow",
  "m³/h": "flow",
  hp: "power",
  min: "time",
  h: "time",
  s: "time",
  dB: "level",
  bar: "pressure",
  psi: "pressure",
  kPa: "pressure",
  cycles: "count",
  "%/K": "temperature-coefficient",
  "mV/K": "temperature-coefficient",
  "V/K": "temperature-coefficient",
  "A/K": "temperature-coefficient",
};

/** What makers write instead. Spanish and French datasheets are common in this trade. */
const ALIASES: Record<string, Unit> = {
  v: "V",
  vdc: "V",
  vac: "V",
  vcd: "V",
  vca: "V",
  vcc: "V",
  // Energizer writes the current's kind as "V d.c." and "A a.c.", which the tail keeps as "Vd.c.".
  "vd.c.": "V",
  "va.c.": "V",
  voc: "V",
  volt: "V",
  volts: "V",
  voltios: "V",
  a: "A",
  adc: "A",
  aac: "A",
  amp: "A",
  amps: "A",
  amperes: "A",
  amperios: "A",
  "ad.c.": "A",
  "aa.c.": "A",
  w: "W",
  watt: "W",
  watts: "W",
  vatios: "W",
  wp: "W",
  va: "VA",
  kva: "kVA",
  ah: "Ah",
  "a.h.": "Ah",
  amphours: "Ah",
  "amp-hours": "Ah",
  "amp-hour": "Ah",
  amperehours: "Ah",
  "ampere-hours": "Ah",
  "ampere-hour": "Ah",
  wh: "Wh",
  kwh: "kWh",
  kw: "kW",
  mv: "mV",
  ma: "mA",
  mah: "mAh",
  hz: "Hz",
  ohm: "Ω",
  ohms: "Ω",
  c: "°C",
  "°c": "°C",
  celsius: "°C",
  f: "°F",
  "°f": "°F",
  "%": "%",
  pct: "%",
  kg: "kg",
  kgs: "kg",
  g: "g",
  lb: "lb",
  lbs: "lb",
  libras: "lb",
  mm: "mm",
  cm: "cm",
  m: "m",
  in: "in",
  "in.": "in",
  inch: "in",
  inches: "in",
  pulgadas: "in",
  pouces: "in",
  ft: "ft",
  "ft.": "ft",
  feet: "ft",
  foot: "ft",
  // A foot mark after the number, as pump sheets write a head: 22’.
  "’": "ft",
  "'": "ft",
  m2: "m²",
  "m^2": "m²",
  l: "L",
  litre: "L",
  liter: "L",
  litres: "L",
  liters: "L",
  gal: "gal",
  "gal.": "gal",
  gallon: "gal",
  gallons: "gal",
  qt: "qt",
  quart: "qt",
  quarts: "qt",
  "l/min": "L/min",
  lpm: "L/min",
  "l/m": "L/min",
  "litres/min": "L/min",
  "liters/min": "L/min",
  gpm: "gpm",
  "gal/min": "gpm",
  "gal./min": "gpm",
  "gal/minute": "gpm",
  "gallon/min": "gpm",
  "gallons/min": "gpm",
  "gallons/minute": "gpm",
  gallonsperminute: "gpm",
  gallonperminute: "gpm",
  galperminute: "gpm",
  "l/minute": "L/min",
  "litres/minute": "L/min",
  "liters/minute": "L/min",
  litresperminute: "L/min",
  litersperminute: "L/min",
  "m3/h": "m³/h",
  "m³/h": "m³/h",
  "m3/hr": "m³/h",
  hp: "hp",
  "h.p.": "hp",
  min: "min",
  mins: "min",
  minutes: "min",
  h: "h",
  hr: "h",
  hrs: "h",
  hours: "h",
  s: "s",
  sec: "s",
  seconds: "s",
  db: "dB",
  bar: "bar",
  psi: "psi",
  kpa: "kPa",
  cycles: "cycles",
  ciclos: "cycles",
  "a/k": "A/K",
  "a/°c": "A/K",
  "a/c": "A/K",
  "a/℃": "A/K",
  "v/k": "V/K",
  "v/°c": "V/K",
  "v/c": "V/K",
  "v/℃": "V/K",
  "mv/k": "mV/K",
  "mv/°c": "mV/K",
  "mv/c": "mV/K",
  "mv/℃": "mV/K",
  "%/k": "%/K",
  "%/°c": "%/K",
  "%/c": "%/K",
  "%/℃": "%/K",
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
 * The key a reader's answer carries on to after a value, which the value sometimes keeps: PD1600's
 * figures came back as "1000W', 'unit': " and NorthStar's as "31 lb, unit:", each a figure followed
 * by the next field of the structure the model was writing in (#188).
 */
const ANSWER_TAIL =
  /\s*['"]?\s*,\s*['"]?(?:unit|units|conditions|page|name)['"]?\s*:\s*['"]?([^'"]*?)['"]?\s*$/i;

/** Where a model wrote a list where one value belongs: `20.70" L x 3.34" dia', '52.58 x 8.48 cm`. */
const ANSWER_LIST = /['"]\s*,\s*['"]/;

/**
 * A value with the answer's own structure taken off it, and the unit that structure named where it
 * named one. What stands before the structure is what the document prints. A value that is nothing
 * but structure is returned as it came, for the truncation check to refuse.
 */
export function withoutAnswerTail(value: string): { value: string; unit?: string } {
  const tail = ANSWER_TAIL.exec(value);
  const head = (tail ? value.slice(0, tail.index) : value).split(ANSWER_LIST)[0] ?? "";
  const printed = head
    .trim()
    .replace(/['"]+$/, "")
    .trim();
  if (!printed) return { value };
  const unit = tail?.[1]?.trim();
  return { value: printed, ...(unit ? { unit } : {}) };
}

/**
 * Pull a unit out of a value that has one glued on. A model told to put the unit in its own field
 * writes "57.6V" anyway, and twenty-two figures in one run did exactly that: the number is right
 * and the unit is right, and only the shape is wrong.
 */
export function splitValueUnit(
  value: string,
  unit: string | undefined,
): { value: string; unit?: string } {
  const canonical = canonicalUnit(unit);
  if (canonical) return { value: decimalPoint(value.trim()), unit: canonical };
  const match = /^(-?\d+(?:[.,]\d+)?)\s*([A-Za-zΩ°℃µ%][A-Za-zΩ°℃µ%²³/·.]{0,9})$/.exec(value.trim());
  const pulled = match ? canonicalUnit(match[2]) : undefined;
  return pulled && match
    ? { value: decimalPoint(match[1]), unit: pulled }
    : { value: decimalPoint(value.trim()) };
}

/**
 * A European decimal comma written as a point. An OutBack sheet gives a case height of "47,2 cm"
 * and a Sol-Ark one a rating of "19,8 kW"; anything reading those as a number gets 472 or 198, so
 * publishing the comma is a trap rather than fidelity. Only a comma with one or two digits after
 * it is a decimal point — a thousands separator always has three, which is why "3,500 lb" and
 * "19,200 W" are left exactly as the maker printed them — unless a lone zero stands before it:
 * Peimar's "0,046 %/°C" is a coefficient, and no maker writes forty-six that way.
 */
function decimalPoint(value: string): string {
  return /^[-+]?(?:\d{1,3},\d{1,2}|0,\d{3})$/.test(value) ? value.replace(",", ".") : value;
}

/**
 * A value that says there is no value. A figure whose value is "None" or "no value given" is an
 * empty row wearing a figure's clothes, and absence is representable: no row at all says the same
 * thing without inviting anyone to read it as a measurement.
 */
const PLACEHOLDER =
  /^(no value given|not given|not stated|not specified|not applicable|none|n\/?a|nil|unknown|tbd|-{1,3}|—)$/i;

/** Whether this value states nothing, so the figure should not be held at all. */
export function statesNothing(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/**
 * Whether a value is a plain number, which is what a figure with a unit ought to be. Exponent
 * form counts: the CEC library writes a coefficient as `-5.04E-05` and a large inverter's DC
 * power as `1.01453e+06`, and both are numbers a reader can use as they are.
 */
export function isNumeric(value: string): boolean {
  return /^-?\d+([.,]\d+)?([eE][+-]?\d+)?$/.test(value.trim());
}

/** Figures that are legitimately a bare number: a count is not a measurement and has no unit. */
const COUNTED =
  /\b(cells?|count|number|quantity|qty|series|parallel|stages?|ports?|outlets?|strings?|modules?|phases?)\b/i;

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
  if (spec.unit && canonicalUnit(spec.unit) && !isNumeric(spec.value))
    out.push("a figure with a unit whose value is not a number");
  if (!spec.unit && isNumeric(spec.value) && !COUNTED.test(spec.name))
    out.push("a number with no unit, so what it measures is unstated");
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

/**
 * Characters the reader writes in place of a symbol it could not copy (#145). Volthium's manual
 * prints "≥8000 cycles" and the reading says "£8000 cycles"; SureCall's "≤ 2.0" came back as
 * "¥ 2.0" and "â€™2.0". Each form below stands where no figure puts it: a currency or section sign,
 * a micro sign or a superscript before a digit, a superscript on its own, a mojibake run, a degree
 * sign turned into "ø" or "¸" between a number and C or F, and symbols no sheet prints in a value.
 * "±5%", "6 mm²", "0ºC" and "20μa" are not among them.
 */
const GARBLED = [
  /[£¥§¶»]\s?\d/,
  /µ\d/,
  /[⁰-₟]+\d/,
  /(^|\s)[⁰-₟](\s|$)/,
  /â€/,
  /[⎖□∔ℇ∥]/,
  /「\s?\d/,
  /\d\s?[ø¸˛][CF]\b/,
];

/**
 * Whether a value carries a symbol the reader garbled. Refused like a truncated value: what the
 * document printed cannot be read back out of it, and "£8000" hides that it meant "at least".
 */
export function looksGarbled(value: string): boolean {
  return GARBLED.some((form) => form.test(value));
}

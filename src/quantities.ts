import type {
  CanonicalUnit,
  Property,
  Quantity,
  Shape,
} from "@origin89/equipment-schema/properties";
import { canonicalUnit, QUANTITY_OF, type Unit } from "./units.ts";

/**
 * Read a printed figure as a number in a canonical unit, or say why it cannot be.
 *
 * A maker prints the same limit as "150", "150 volts DC", "150 Vdc maximum" and "850V/850V/850V";
 * a range as "8 - 72 Volts dc", "120~385 V" or "425 to 850 Vdc"; a coefficient as "-0,29 %/°C".
 * Each of those is one figure, and a consumer comparing a string voltage with a controller's
 * limit needs the number (#82). Nothing here guesses: a value that is a bound, a sentence, or a
 * number with no unit comes back unparsed with the reason, and the printed figure stays as it is.
 */

export type Parsed =
  | { shape: "scalar"; value: number; unit: CanonicalUnit }
  | { shape: "range"; min: number; max: number; unit: CanonicalUnit }
  | { shape: "set"; values: number[]; unit: CanonicalUnit };

export type Read = { ok: true; parsed: Parsed } | { ok: false; reason: string };

/** What a maker writes around a unit that is not part of it: "Vdc maximum", "watts DC". */
const QUALIFIER =
  /^(dc|ac|max|maximum|min|minimum|typ|typical|nom|nominal|rms|peak|cont|continuous)$/i;

/** A leading comparison or approximation. "< 5W" bounds the figure without stating it. */
const BOUND = /^(?:<|>|≤|≥|≈|~|±|less than|more than|up to|under|over|about|approx\.?|circa)\s*/i;

/** A number as printed: "1,000", "0,29", "-0.25", "+0.05", "3500", and ".281" with the zero left off. */
const NUMBER = String.raw`[-+]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?|\.\d+)`;
/** What separates the ends of a range: a dash of any width, a tilde, "to", or a dash a decoder turned into a quote. */
const RANGE = String.raw`\s*(?:-|–|—|~|～|to|")\s*`;
/** A unit glued to or spaced after a number, up to the next number: "VDC" in "43 VDC to 59 VDC". */
const UNIT_TAIL = String.raw`[A-Za-z°℃µ%][A-Za-z°℃µ%/·.]*`;
/** A range, whose first end may carry its own unit: "8 - 72 Volts dc", "0A~140A", "-20°C to 60°C". */
const RANGE_TERM = new RegExp(`^(${NUMBER})\\s*(${UNIT_TAIL})?${RANGE}(${NUMBER})\\s*(.*)$`);
const SCALAR_TERM = new RegExp(`^(${NUMBER})\\s*(.*)$`);
/** A motor's power as pump sheets print it, "1/2 HP" or a bare "4/10" in a horsepower column: one figure, not two. */
const FRACTIONAL_HP = /^(\d+)\s*\/\s*(\d+)\s*(hp|h\.p\.|horsepower)?\s*$/i;
/**
 * An aside a maker prints after the unit: the bank a charger's amps are for, "5A (12V)"; a word,
 * "24A (Max)"; the same figure in other units, "2.5 gpm (9.5 Lpm)"; a tolerance, "13kW(±5%)".
 * The unit is what stands before it, and a condition in it is read from the figure's words
 * elsewhere. An aside that states another figure of the same kind, "190A (software limited
 * 185A)", changes what the figure means, and the value stays unparsed rather than overstated.
 */
const ASIDE = /\s*\([^()]*\)\s*$/;
const TOLERANCE = new RegExp(String.raw`^(?:±|\+/-|\+-)\s*${NUMBER}\s*(%|${UNIT_TAIL})?$`);
/** The phases a figure is across, "L-L" or "L1-N", or the conductors it counts, "L1+L2+L3+N+PE": a note, not a figure. */
const WIRING = /^(?:L\d?\s*[-–]\s*[LN]\d?|(?:L\d?|N|PE)(?:\s*[+,/]\s*(?:L\d?|N|PE))+)$/i;
/**
 * A lead-acid sheet ends a capacity with the cell voltage it is drawn down to, "155 A.H. to 1.70
 * VPC": a condition of the figure, not a second end of a range.
 */
const CUT_OFF = new RegExp(String.raw`\s*(?:to|@|at)\s*${NUMBER}\s*V\.?\s?P\.?\s?C\.?\s*$`, "i");

/**
 * "1,000" is a thousand and "0,29" is a fraction: a thousands comma always has three digits after
 * it, and never a lone zero before it, so "0,046 %/°C" is a coefficient and not forty-six. A number
 * too long to be finite is not a number, so nothing downstream sees Infinity.
 */
function toNumber(text: string): number | undefined {
  const cleaned = /^[-+]?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(text)
    ? text.replaceAll(",", "")
    : text.replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** A converted number, or nothing when the conversion carried it past what a number can hold. */
const finite = (n: number): number | undefined => (Number.isFinite(n) ? tidy(n) : undefined);

/**
 * The unit a tail of text means, or the tail itself when it means none. The whole tail is tried
 * first, so "min" is minutes; only then are the words around a unit dropped, so "Vdc maximum" is
 * volts. Anything left over that is not a unit makes the tail not a unit: "V ± 0.1V" states two
 * figures, and "% of the designed capacity" a share of something unstated.
 */
function unitOf(tail: string): { unit?: Unit; rest: string } {
  const words = tail.replace(/℃/g, "°C").split(/\s+/).filter(Boolean);
  const whole = words.join("");
  if (!whole) return { rest: "" };
  const asPrinted = canonicalUnit(whole);
  if (asPrinted) return { unit: asPrinted, rest: "" };
  const bare = words.filter((word) => !QUALIFIER.test(word)).join("");
  const unit = canonicalUnit(bare);
  return unit ? { unit, rest: "" } : { rest: whole };
}

type Term = { min: number; max?: number; unit?: Unit };

/** A term's closing aside, "(12V)" in "5A (12V)", and the term without it; a term that is all aside keeps it. */
function splitAside(text: string): { main: string; aside?: string } {
  const found = ASIDE.exec(text);
  if (!found) return { main: text };
  const main = text.slice(0, found.index).trim();
  return main ? { main, aside: found[0].trim().slice(1, -1).trim() } : { main: text };
}

/** How many decimals each number in a text is printed with, so "6.7 m" is taken as 6.65 to 6.75. */
const decimalsOf = (text: string): number[] =>
  [...text.matchAll(new RegExp(NUMBER, "g"))].map((m) => m[0].split(/[.,]/)[1]?.length ?? 0);

/** A unit's way into its canonical unit, or nothing for a unit that has none. */
const canonical = (unit: Unit): { to: string; by: (n: number) => number } | undefined =>
  CONVERT[unit] ?? (CANONICAL.has(unit) ? { to: unit, by: (n) => n } : undefined);

/**
 * Whether an aside that carries numbers restates the figure rather than changing it: a figure
 * in another quantity, "5A (12V)"; a tolerance, "(±5%)" or "(± 5 VAC)"; or the same figure in
 * other units, "2.25 gal. (8.50 L)", agreeing to within the rounding of the aside's own digits.
 * The same figure in the same unit has to agree exactly: "190A (188A)" is two figures. Anything
 * else with a number in it, "(software limited 185A)" or "(< 8 ms)", changes the figure.
 */
function asideAgrees(term: Term, aside: string): boolean {
  const tolerance = TOLERANCE.exec(aside);
  if (tolerance) {
    // A share, or a bare number, is a tolerance of the figure; a unit has to be the figure's own kind.
    const [, tail] = tolerance;
    if (tail === undefined || tail === "%") return true;
    const { unit } = unitOf(tail);
    return (
      unit !== undefined && term.unit !== undefined && QUANTITY_OF[unit] === QUANTITY_OF[term.unit]
    );
  }
  if (term.unit === undefined) return false;
  const other = parseBare(aside);
  if (typeof other === "string" || other.unit === undefined) return false;
  // A figure of another kind restates this one, "5A (12V)"; a range of another kind, "5A (12-24V)",
  // is a condition the figure holds across, which nothing downstream can keep whole.
  if (QUANTITY_OF[other.unit] !== QUANTITY_OF[term.unit]) return other.max === undefined;
  if ((term.max === undefined) !== (other.max === undefined)) return false;
  const mine = canonical(term.unit);
  const theirs = canonical(other.unit);
  if (!mine || !theirs || mine.to !== theirs.to) return false;
  const [lowDecimals = 0, highDecimals = lowDecimals] = decimalsOf(aside);
  const agrees = (a: number, b: number, decimals: number): boolean => {
    if (term.unit === other.unit) return Math.abs(a - b) < 1e-9;
    // The rounding of the aside's printed digits, or half a percent where a maker rounded a
    // conversion loosely, "2.25 gal. (8.50 L)"; never enough to let "1100mA (1.00A)" through.
    const half = 0.5 * 10 ** -decimals;
    const printed = Math.abs(theirs.by(b));
    const tolerance = Math.max(Math.abs(theirs.by(b + half) - theirs.by(b)), printed / 200);
    return Math.abs(mine.by(a) - theirs.by(b)) <= tolerance + 1e-9;
  };
  return (
    agrees(term.min, other.min, lowDecimals) &&
    (term.max === undefined || other.max === undefined || agrees(term.max, other.max, highDecimals))
  );
}

function parseTerm(part: string): Term | string {
  const printed = part.trim();
  // The cut-off is a capacity's: "2.35 to 2.40 VPC" is a range of cell voltages and keeps its end.
  const cut = printed.replace(CUT_OFF, "");
  const text = cut !== printed && isCharge(parseBare(splitAside(cut).main)) ? cut : printed;
  const { main, aside } = splitAside(text);
  const term = parseBare(main);
  if (aside === undefined || typeof term === "string") return term;
  if (!/\d/.test(aside) || WIRING.test(aside)) {
    // A qualifier, "Max"; the phases or conductors, "L-L"; or the unit itself when nothing else
    // names it, "72 (W)". Any other words, "per input", say something the figure does not.
    if (QUALIFIER.test(aside) || WIRING.test(aside)) return term;
    const unit = canonicalUnit(aside);
    if (unit && term.unit === undefined) return { ...term, unit };
    if (unit) return term;
    return `"(${aside})" changes the figure`;
  }
  return asideAgrees(term, aside) ? term : `"(${aside})" changes the figure`;
}

/** Whether a term reads in ampere-hours, the figure a cut-off voltage belongs to. */
const isCharge = (term: Term | string): boolean =>
  typeof term !== "string" && term.unit !== undefined && QUANTITY_OF[term.unit] === "charge";

/**
 * The alternatives a value lists with slashes, "12/24/48V DC", split only outside brackets: the
 * slash in "13kW (+/-5%)" is the tolerance's, not a second figure.
 */
function alternatives(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "/" && depth === 0 && /^\s*[-\d.]/.test(text.slice(i + 1))) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/**
 * The asides of a value that say something about the figure rather than restating it: a figure
 * of another kind, "(12V)" on a charger's amps or "(15s)" on a peak, whose words the builder reads
 * as the figure's conditions. One list per alternative, so "5A (12V)/5A (24V)" is two. A tolerance,
 * a wiring note, a qualifier and the same figure in other units say nothing more and are left out;
 * an aside that is no figure at all makes the value unparsed elsewhere and is left out too.
 */
export function conditionAsides(value: string): string[][] {
  const text = value.trim().replace(/[“”]/g, '"').replace(/\s+/g, " ");
  return alternatives(text).map((part) => {
    const { main, aside } = splitAside(part.trim().replace(CUT_OFF, ""));
    if (aside === undefined || !/\d/.test(aside) || WIRING.test(aside) || TOLERANCE.test(aside))
      return [];
    const term = parseBare(main);
    const other = parseBare(aside);
    if (typeof term === "string" || typeof other === "string") return [];
    if (term.unit === undefined || other.unit === undefined) return [];
    return QUANTITY_OF[other.unit] === QUANTITY_OF[term.unit] ? [] : [aside];
  });
}

/** A term with no aside: one number with its unit, or a range. */
function parseBare(text: string): Term | string {
  const ranged = RANGE_TERM.exec(text);
  if (ranged) {
    const [, first = "", firstTail = "", second = "", tail = ""] = ranged;
    const low = unitOf(firstTail);
    const high = unitOf(tail);
    if (low.rest) return `"${low.rest}" is not a unit`;
    if (high.rest) return `"${high.rest}" is not a unit`;
    if (low.unit && high.unit && low.unit !== high.unit) return "two units in one figure";
    const min = toNumber(first);
    const max = toNumber(second);
    if (min === undefined || max === undefined) return `"${text}" is not a figure`;
    return { min, max, unit: low.unit ?? high.unit };
  }
  const match = SCALAR_TERM.exec(text);
  if (!match) return `"${text}" is not a figure`;
  const [, first = "", tail = ""] = match;
  // "12-Volts": a hyphen between the number and a unit written as a word is the maker's spelling.
  const { unit, rest } = unitOf(tail.replace(/^-(?=[A-Za-z])/, ""));
  if (rest) return `"${rest}" is not a unit`;
  const min = toNumber(first);
  if (min === undefined) return `"${text}" is not a figure`;
  return { min, unit };
}

/** Conversions into the units properties are published in. A unit not here is already canonical or has no canonical form. */
const CONVERT: Partial<Record<Unit, { to: CanonicalUnit; by: (n: number) => number }>> = {
  kW: { to: "W", by: (n) => n * 1000 },
  kVA: { to: "VA", by: (n) => n * 1000 },
  kWh: { to: "Wh", by: (n) => n * 1000 },
  mV: { to: "V", by: (n) => n / 1000 },
  mA: { to: "A", by: (n) => n / 1000 },
  mAh: { to: "Ah", by: (n) => n / 1000 },
  "°F": { to: "°C", by: (n) => ((n - 32) * 5) / 9 },
  min: { to: "s", by: (n) => n * 60 },
  h: { to: "s", by: (n) => n * 3600 },
  gal: { to: "L", by: (n) => n * 3.785411784 },
  qt: { to: "L", by: (n) => n * 0.946352946 },
  gpm: { to: "L/min", by: (n) => n * 3.785411784 },
  "m³/h": { to: "L/min", by: (n) => (n * 1000) / 60 },
  psi: { to: "bar", by: (n) => n * 0.0689475729 },
  kPa: { to: "bar", by: (n) => n / 100 },
  ft: { to: "m", by: (n) => n * 0.3048 },
  in: { to: "m", by: (n) => n * 0.0254 },
  cm: { to: "m", by: (n) => n / 100 },
  mm: { to: "m", by: (n) => n / 1000 },
  hp: { to: "W", by: (n) => n * 745.6998716 },
};

const CANONICAL = new Set<string>([
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

/** Ten significant figures: enough that a conversion does not print as 0.30000000000000004. */
const tidy = (n: number): number => Number(n.toPrecision(10));

export interface ParseOptions {
  /**
   * The figure a coefficient is a share of, in the canonical unit: a panel's Voc at STC turns
   * "-0.08 V/K" into a percentage. Without it a coefficient printed in volts or amps stays unparsed.
   */
  reference?: number;
}

/**
 * Read a value, with the unit the figure carried if any, as the quantity asked for. The unit in
 * the text wins over the field when both are there and agree; when they disagree, nothing is
 * chosen between them.
 */
export function parseQuantity(
  value: string,
  unit: string | undefined,
  quantity: Quantity,
  options: ParseOptions = {},
): Read {
  // A generator sheet writes alternating current as a trailing tilde: "120/240~" is 120 or 240 V AC.
  const text = value
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/(?<=[\dA-Za-z])\s*~$/, "");
  if (!text) return { ok: false, reason: "no value" };
  if (BOUND.test(text)) return { ok: false, reason: "a bound or an approximation, not a figure" };
  const fraction = FRACTIONAL_HP.exec(text);
  const horsepower = fraction && (fraction[3] !== undefined || canonicalUnit(unit) === "hp");
  // "12/24/48V DC", "850V/850V/850V" and ".5/.7A" are alternatives; "%/°C" is one unit; "1/2 HP" is a half.
  const parts = horsepower
    ? [`${Number(fraction[1]) / Number(fraction[2])} hp`]
    : alternatives(text);
  const terms: Term[] = [];
  for (const part of parts) {
    const term = parseTerm(part);
    if (typeof term === "string") return { ok: false, reason: term };
    terms.push(term);
  }
  // A part with no unit of its own takes the one printed after the last: "8 - 72 Volts dc".
  const printed = terms.map((t) => t.unit).filter((u): u is Unit => u !== undefined);
  const inText = printed.at(-1);
  if (printed.some((u) => u !== inText)) return { ok: false, reason: "two units in one figure" };
  const given = canonicalUnit(unit);
  if (inText && given && inText !== given)
    return { ok: false, reason: `printed in ${inText} but the unit field says ${given}` };
  const found = inText ?? given;
  if (!found) return { ok: false, reason: "no unit" };

  const ranges = terms.filter((t) => t.max !== undefined);
  if (ranges.length > 0 && ranges.length < terms.length)
    return { ok: false, reason: "a range beside a single figure" };

  const converted = convert(found, quantity, options);
  if (typeof converted === "string") return { ok: false, reason: converted };
  const { to, by } = converted;
  if (ranges.length > 0) {
    // Several inputs printed with one range each are one range when they agree: "80-500Vdc / 80-500Vdc".
    const [first] = ranges;
    if (!first || ranges.some((r) => r.min !== first.min || r.max !== first.max))
      return { ok: false, reason: "several ranges that differ" };
    const [lo, hi] = [finite(by(first.min)), finite(by(first.max ?? first.min))];
    if (lo === undefined || hi === undefined)
      return { ok: false, reason: `too large to hold in ${to}` };
    if (lo > hi) return { ok: false, reason: "a range whose ends are reversed" };
    return { ok: true, parsed: { shape: "range", min: lo, max: hi, unit: to } };
  }
  const numbers = terms.map((t) => finite(by(t.min)));
  if (numbers.some((v) => v === undefined))
    return { ok: false, reason: `too large to hold in ${to}` };
  const values = [...new Set(numbers.filter((v): v is number => v !== undefined))];
  const [only] = values;
  if (values.length === 1 && only !== undefined)
    return { ok: true, parsed: { shape: "scalar", value: only, unit: to } };
  return { ok: true, parsed: { shape: "set", values, unit: to } };
}

/** A figure's value split by the quantity each part is printed in: "6KVA/6KW" is two. */
export interface PrintedPart {
  quantity: Quantity;
  value: string;
}

/**
 * The unit a part of a value is printed in, read loosely: "4000 VA (L-L)" is volt-amperes even
 * though the aside is not a unit. Only the unit on the part's own figure counts: in
 * "6000 @ 240 VAC" the volts belong to the annotation, and the part's unit is whatever the
 * unit field says.
 */
function looseUnit(part: string): Unit | undefined {
  const term = parseTerm(part);
  if (typeof term !== "string") return term.unit;
  const tail = new RegExp(`^${NUMBER}\\s*(${UNIT_TAIL})`).exec(part)?.[1];
  if (!tail) return undefined;
  for (const candidate of [
    tail,
    tail.replace(/[^A-Za-z°%/]+.*$/, ""),
    /^[A-Za-z]+/.exec(tail)?.[0] ?? "",
  ]) {
    const unit = canonicalUnit(candidate);
    if (unit) return unit;
  }
  return undefined;
}

/**
 * The quantities a figure is printed in, from its unit field or the units in its text, whatever
 * the value's shape or wording, with the part of the value each covers: "up to 500 VA" is
 * apparent power though it is not a figure, "6KVA/6KW" is apparent power and power, "12/24/48V"
 * is one voltage whose first parts take the unit printed after the last. Empty when no unit can
 * be read.
 */
export function printedQuantities(value: string, unit: string | undefined): PrintedPart[] {
  // A unit in the text says more than the unit field: "6KVA/6KW" in a field marked VA is still
  // two quantities. The field is what a part with no unit of its own is printed in.
  const given = canonicalUnit(unit);
  const printed = value.trim().replace(/[“”]/g, '"').replace(/\s+/g, " ");
  // A bound belongs to every part it qualifies: "up to 6KVA/6KW" is two bounded figures, not two figures.
  const bound = BOUND.exec(printed)?.[0] ?? "";
  const text = printed.slice(bound.length);
  const parts = alternatives(text).map((part) => `${bound}${part}`);
  const units: (Unit | undefined)[] = parts.map((part) => looseUnit(part.slice(bound.length)));
  for (let i = units.length - 2; i >= 0; i--) units[i] ??= units[i + 1];
  if (given && units.every((u) => u === undefined))
    return [{ quantity: QUANTITY_OF[given] as Quantity, value }];
  for (let i = 0; i < units.length; i++) units[i] ??= given;
  const out: PrintedPart[] = [];
  parts.forEach((part, i) => {
    const u = units[i];
    if (!u) return;
    const quantity = QUANTITY_OF[u] as Quantity;
    const last = out.at(-1);
    if (last && last.quantity === quantity) last.value = `${last.value}/${part}`;
    else out.push({ quantity, value: part });
  });
  return out;
}

/** The quantity a figure is printed in, or the first of several. */
export function printedQuantity(value: string, unit: string | undefined): Quantity | undefined {
  return printedQuantities(value, unit)[0]?.quantity;
}

/** How a printed unit reaches the canonical one of its quantity, or why it cannot. */
function convert(
  unit: Unit,
  quantity: Quantity,
  { reference }: ParseOptions,
): { to: CanonicalUnit; by: (n: number) => number } | string {
  const measures = QUANTITY_OF[unit];
  if (measures !== quantity) return `${unit} measures ${measures}, not ${quantity}`;
  if (quantity === "temperature-coefficient" && unit !== "%/K") {
    // A coefficient in volts or amps per kelvin is a share of the STC figure, which only the
    // caller has.
    if (reference === undefined || reference === 0)
      return `${unit} needs the figure it is a share of to become %/K`;
    const scale = unit === "mV/K" ? 1 / 1000 : 1;
    return { to: "%/K", by: (n) => (n * scale * 100) / reference };
  }
  const known = CONVERT[unit];
  if (known) return known;
  if (CANONICAL.has(unit)) return { to: unit as CanonicalUnit, by: (n) => n };
  return `${unit} has no canonical form`;
}

/**
 * A value read for one property: parsed as the property's quantity, in the property's unit, and
 * in the shape the property has. A set of one alternative is a scalar, and several inputs printed
 * with the same limit are one limit; a range where one figure is needed, or one figure where a
 * range is, is refused rather than halved or widened.
 */
export function readProperty(
  value: string,
  unit: string | undefined,
  property: Pick<Property, "quantity" | "unit" | "shape">,
  options: ParseOptions = {},
): Read {
  const read = parseQuantity(value, unit, property.quantity, options);
  if (!read.ok) return read;
  const { parsed } = read;
  if (parsed.unit !== property.unit)
    return { ok: false, reason: `${parsed.unit} is not ${property.unit}` };
  if (fits(parsed.shape, property.shape)) return read;
  if (parsed.shape === "scalar" && property.shape === "set")
    return { ok: true, parsed: { shape: "set", values: [parsed.value], unit: parsed.unit } };
  return { ok: false, reason: `a ${parsed.shape} where a ${property.shape} is needed` };
}

const fits = (found: Shape, wanted: Shape): boolean => found === wanted;

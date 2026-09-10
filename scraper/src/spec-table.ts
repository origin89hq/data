import { decodeHTML } from "entities";
/**
 * Read a manufacturer's own specification table. Many makers publish the same figures as an HTML
 * table with a column per model, and that table is exact: the maker wrote the figure names, the
 * units are attached to the values, and no model has to read anything out of a picture.
 *
 * A Victron page gives four charge controllers side by side. Its PDF gives scrambled chart
 * labels. This is the same information, machine-readable, and it costs nothing to parse.
 */

/** Which reader produced a figure, carried onto every spec row so provenance is never implied. */
export const TABLE_READER = "table:spec-table@v1";

export interface TableSpec {
  name: string;
  value: string;
  unit?: string;
}

export interface TableProduct {
  model: string;
  specs: TableSpec[];
}

const TABLE = /<table[^>]*>([\s\S]*?)<\/table>/gi;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<(t[dh])([^>]*)>([\s\S]*?)<\/\1>/gi;

/**
 * Strip the markup and decode the entities. The hand-written list this replaced knew four names and
 * the numeric form, so a Rolls temperature table came out reading "40&deg;C (104&deg;F)" — text that
 * would have been stored as a figure's value had the page not been refused for another reason.
 * Spec sheets are full of &deg;, &plusmn;, &times; and &ndash;, so the table has to be the real one.
 */
const text = (html: string): string =>
  decodeHTML(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** What a page turned out to be worth, so a candidate can be judged rather than guessed at. */
export interface SpecPageCandidate {
  url: string;
  products: number;
  figures: number;
  /** How many figures came out with a unit, which is what separates a specification table from prose. */
  withUnit: number;
  models: string[];
}

/**
 * Judge a page as a source of figures. Discovery already fetches these pages to look for document
 * links, so testing each one for a specification table costs nothing extra and turns a hand-typed
 * feed list into an evidenced one.
 */
export function judgeSpecPage(url: string, html: string): SpecPageCandidate | undefined {
  const products = parseSpecTables(html);
  if (products.length === 0) return undefined;
  const specs = products.flatMap((p) => p.specs);
  return {
    url,
    products: products.length,
    figures: specs.length,
    withUnit: specs.filter((s) => s.unit).length,
    models: products.slice(0, 6).map((p) => p.model),
  };
}

/** A cell that spans several columns fills each of them, so a row still lines up with its header. */
function cells(row: string): string[] {
  const out: string[] = [];
  CELL.lastIndex = 0;
  for (let m = CELL.exec(row); m; m = CELL.exec(row)) {
    const span = Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(m[2])?.[1] ?? "1");
    const value = text(m[3]);
    for (let i = 0; i < Math.max(1, Math.min(span, 12)); i += 1) out.push(value);
  }
  return out;
}

const UNIT = /^(-?\d+(?:[.,]\d+)?)\s*([A-Za-zΩ°µ%][A-Za-zΩ°µ%²³/·.]{0,9})$/;

/**
 * Split "145W" into 145 and W. A value that is not a bare number with a unit stays whole: "12V or
 * 24V" is two options and "Yes" is not a measurement, and inventing a unit for either would be
 * worse than leaving it as the maker wrote it.
 */
export function splitValue(raw: string): TableSpec | undefined {
  const value = raw.trim();
  if (!value || value === "-" || value === "–" || /^n\/?a$/i.test(value)) return undefined;
  const match = UNIT.exec(value);
  if (!match) return { name: "", value };
  return { name: "", value: match[1].replace(",", "."), unit: match[2] };
}

/** Words a specification table uses for its attributes. A header full of these is a table on its side. */
const ATTRIBUTE = /^(warranty|weight|voltage|capacity|current|power|dimensions?|size|colour|color|type|model|description|notes?|features?|price|part|sku|qty|quantity|series|温度|温度範囲)$/i;

/** A measurement is a value, so a header cell that is one belongs in the body: "5 Years", "40°C". */
const MEASUREMENT_CELL = /^\d+([.,]\d+)?\s*(years?|months?|days?|hours?|°?[cf]\b|kg|lbs?|mm|cm|m|in|v|a|w|ah|wh|kwh)\b/i;

/**
 * Whether a header row names products rather than describing the table. Model names repeat a
 * family and differ in a number — "MPPT 75/10", "MPPT 75/15" — while a table written the other way
 * up puts its attributes across the top, and Rolls' battery pages do exactly that: a header of
 * "Warranty", "5 Years", "40°C" was read as three products until this looked at what the cells
 * actually were.
 */
function looksLikeModels(header: string[]): boolean {
  const named = header.slice(1).filter(Boolean);
  if (named.length < 2) return false;
  const attributes = named.filter((h) => ATTRIBUTE.test(h) || MEASUREMENT_CELL.test(h)).length;
  if (attributes > 0) return false;
  const coded = named.filter((h) => /\d/.test(h) && h.length <= 48);
  return coded.length >= Math.max(2, Math.ceil(named.length / 2));
}

/**
 * Every product a page's tables describe. A table whose header does not name products is skipped,
 * because a specification page also carries tables of footnotes and ordering codes.
 */
export function parseSpecTables(html: string): TableProduct[] {
  const products = new Map<string, TableProduct>();
  TABLE.lastIndex = 0;
  for (let t = TABLE.exec(html); t; t = TABLE.exec(html)) {
    const rows: string[][] = [];
    ROW.lastIndex = 0;
    for (let r = ROW.exec(t[1]); r; r = ROW.exec(t[1])) rows.push(cells(r[0]));
    if (rows.length < 2) continue;
    const header = rows[0];
    if (!looksLikeModels(header)) continue;

    for (const row of rows.slice(1)) {
      const name = row[0]?.trim();
      if (!name || row.length < 2) continue;
      // A section header spans the table and repeats itself in every column — "ENCLOSURE" against
      // "ENCLOSURE". It divides the rows below it; it is not a figure about any of them.
      const spanning = row.slice(1).filter(Boolean);
      if (spanning.length > 0 && spanning.every((c) => c === name)) continue;
      for (let column = 1; column < header.length; column += 1) {
        const model = header[column]?.trim();
        const raw = row[column]?.trim();
        if (!model || !raw || raw === name) continue;
        const spec = splitValue(raw);
        if (!spec) continue;
        const product = products.get(model) ?? { model, specs: [] };
        // The first statement of a figure wins. A page often repeats a row across tables, and the
        // repeat is the same fact, not a second one.
        if (!product.specs.some((s) => s.name === name)) product.specs.push({ ...spec, name });
        products.set(model, product);
      }
    }
  }
  return [...products.values()].filter((p) => p.specs.length > 0);
}

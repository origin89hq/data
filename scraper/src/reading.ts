/**
 * Reading a manufacturer's documents: the prompt, the windowing and the merge. Kept apart from
 * the workflow that runs them so they can be tested without a Workers runtime, which is the same
 * split the classifier uses.
 */

/**
 * Which converter produced a markdown file, in its key. A better converter later writes a second
 * file beside the first and moves nothing, and every citation points at the document's hash
 * rather than at the markdown, so a bad conversion can be thrown away without touching what
 * cites it.
 */
export const CONVERTER = "cf-tomarkdown-v1";

/** What one document's conversion produced, or why it produced nothing. */
export interface Converted {
  sha256: string;
  url: string;
  key?: string;
  characters?: number;
  error?: string;
}

export const EXTRACT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const EXTRACT_PROMPT_VERSION = "2";
export const EXTRACTOR_ID = `ai:${EXTRACT_MODEL}@p${EXTRACT_PROMPT_VERSION}`;

/**
 * How much of a document goes into one call. A datasheet's ratings are usually in one table, and
 * a long manual is mostly prose, so a window that catches a table whole beats a bigger one that
 * splits it down the middle.
 */
export const CHUNK_CHARACTERS = 6000;
export const CHUNK_OVERLAP = 600;

/**
 * How many windows one extraction run will read. Converting a PDF to markdown is free while the
 * document has a text layer, but reading it is a 70B model over every window, at $0.293 per
 * million input tokens and $2.253 per million output. That is about a cent for a datasheet and
 * real money for a maker with a four-hundred-page manual, so a run stops at the budget and says
 * it stopped rather than working through the catalogue unasked.
 */
export const MAX_WINDOWS = 400;

export const SYSTEM = `You read manufacturer documents and report the rated figures they state.

Report only figures the text actually gives. Never calculate, convert, round or infer one. If the text gives no ratings, answer with an empty list.

MODEL. Give the model exactly as printed, and only for a single product. A family or a series — "MS Series", "CSW SERIES", "Tracer AN" — is not a model: if the text gives a table of several products under one family, report each product separately under its own model. If you cannot tell which product a figure belongs to, do not report the figure.

VALUE. One figure, one value. "400 W, 1000 W and 2000 W" is three products' figures written together, not one value: report them under their own models, or not at all. Keep a value exactly as printed otherwise, so "12/24" stays "12/24".

UNIT. Give the unit on its own, not inside the name and not inside the value: "Rated capacity" with value "428" and unit "Ah", never "Rated Capacity (Ah)" with value "428 Ah". A figure with no unit is only right for something that has none — a chemistry, a connector type, a protocol name, a yes or no.

CONDITIONS. What the figure is true under, when the text says: the discharge rate, the temperature, the bank voltage. A capacity without its rate is not a capacity.

Do not report prices, warranty periods, part numbers, packaging weights, ordering codes or marketing claims.`;

/** A name that describes a line of products rather than one of them. */
const SERIES = /\b(series|family|range|line-?up)\b/i;

/** Whether a reported model names one product. A family's figures belong to its members, not to it. */
export function namesOneProduct(model: string): boolean {
  const name = model.trim();
  if (!name || name.length > 60) return false;
  return !SERIES.test(name);
}

const NUMBER_WITH_UNIT = /\d[\d.,]*\s*[A-Za-zΩ°µ%]+/g;
const JOINER = /(,|\band\b|\bor\b|;)/i;

/**
 * Whether a value states one figure. "400 W, 1000 W and 2000 W" is three products' figures written
 * together and attaching it to any one of them is wrong. A dimension is not a list — "216 x 295 x
 * 103mm" is one measurement — and neither is a range written with a dash.
 */
export function statesOneFigure(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 120) return false;
  if (/[x×]/i.test(text)) return true;
  const numbers = text.match(NUMBER_WITH_UNIT) ?? [];
  return numbers.length < 2 || !JOINER.test(text);
}

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          model: { type: "string" },
          specs: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, value: { type: "string" }, unit: { type: "string" }, conditions: { type: "string" } },
              required: ["name", "value"],
            },
          },
        },
        required: ["model", "specs"],
      },
    },
  },
  required: ["products"],
};

/** One window of a document, and the page it starts on. */
export interface Window {
  text: string;
  /** The converter writes "### Page N" headings, which is how a figure keeps a page to be checked against. */
  page?: number;
}

const PAGE_HEADING = /^#{1,6}\s*Page\s+(\d+)\s*$/gim;

/** Where each page of the converted document begins, so a window can say which page it started on. */
export function pageOffsets(markdown: string): { page: number; at: number }[] {
  PAGE_HEADING.lastIndex = 0;
  const out: { page: number; at: number }[] = [];
  for (let m = PAGE_HEADING.exec(markdown); m; m = PAGE_HEADING.exec(markdown)) out.push({ page: Number(m[1]), at: m.index });
  return out;
}

/**
 * Split a document into windows that overlap, so a ratings table straddling a boundary is seen
 * whole at least once, and carry the page each window starts on. A figure without a page is a
 * figure nobody can go back and check.
 */
export function chunk(markdown: string, size = CHUNK_CHARACTERS, overlap = CHUNK_OVERLAP): Window[] {
  const pages = pageOffsets(markdown);
  const pageAt = (offset: number): number | undefined => {
    let page: number | undefined;
    for (const p of pages) {
      if (p.at > offset) break;
      page = p.page;
    }
    return page;
  };
  if (markdown.length <= size) return markdown.trim() ? [{ text: markdown, ...(pageAt(0) === undefined ? {} : { page: pageAt(0) }) }] : [];
  const out: Window[] = [];
  for (let start = 0; start < markdown.length; start += size - overlap) {
    const text = markdown.slice(start, start + size);
    if (text.trim()) {
      const page = pageAt(start);
      out.push({ text, ...(page === undefined ? {} : { page }) });
    }
    if (start + size >= markdown.length) break;
  }
  return out;
}

export interface Reported {
  model: string;
  specs: { name: string; value: string; unit?: string; conditions?: string; page?: number }[];
}

/** Merge what several windows reported about one document, so a product named twice is one entry. */
export function mergeReports(reports: Reported[]): Reported[] {
  const byModel = new Map<string, Reported>();
  for (const r of reports) {
    const model = r.model?.trim();
    if (!model || !Array.isArray(r.specs)) continue;
    // The prompt asks for one product and one figure. These refuse the answers that ignore it,
    // because a series' figures belong to its members and a list of three belongs to three.
    if (!namesOneProduct(model)) continue;
    const key = model.toLowerCase();
    const existing = byModel.get(key) ?? { model, specs: [] };
    for (const s of r.specs) {
      if (typeof s?.name !== "string" || typeof s?.value !== "string") continue;
      if (!statesOneFigure(s.value)) continue;
      const seen = `${s.name.trim().toLowerCase()}|${s.value.trim()}|${(s.conditions ?? "").trim().toLowerCase()}`;
      if (existing.specs.some((x) => `${x.name.trim().toLowerCase()}|${x.value.trim()}|${(x.conditions ?? "").trim().toLowerCase()}` === seen)) continue;
      existing.specs.push(s);
    }
    byModel.set(key, existing);
  }
  return [...byModel.values()].filter((r) => r.specs.length > 0).sort((a, b) => a.model.localeCompare(b.model));
}


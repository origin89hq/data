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

/** The answer every reader gives, differing only in which fields of a figure it must fill. */
function figuresSchema(figureRequired: string[]) {
  return {
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
                required: figureRequired,
              },
            },
          },
          required: ["model", "specs"],
        },
      },
    },
    required: ["products"],
  };
}

export const RESPONSE_SCHEMA = figuresSchema(["name", "value"]);

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

/**
 * The second reader, for documents the first cannot see into.
 *
 * `toMarkdown` does not fail on a scanned PDF. It succeeds, and returns a title, a metadata block
 * and one heading per page with nothing under any of them — so the text reader reads 284
 * characters, finds nothing, writes an empty reading, and the document counts as read. 365
 * approved documents went that way and none of their readings held a figure, among them spec
 * sheets with a full table of ratings. Some are photographs of paper; about a third are sheets
 * whose type was turned into outlines, and have no image in them to pull out either.
 *
 * So this reader draws each page and does two things with it. A model that reads pictures writes
 * the page down as Markdown, and the same model reads the figures out of what it wrote. The
 * transcription is kept, put together into a conversion of the whole document beside the one
 * `toMarkdown` made, so a scan can be read again by any later reader without looking at a picture,
 * and a figure can be checked against the text it came from and that text against the page.
 *
 * Which model was decided by reading the same scanned pages many times over, because a page is
 * read once:
 *
 * - GLM-5.3-flash laid figures out best and could not be trusted with them. One read in a dozen of
 *   an RM-12 sheet invented a whole table — "<10 mA", "9-16 V", a humidity range the page never
 *   prints — and another read 9600 baud as 96000. With its thinking on it invented more, not less.
 * - Llama 4 Scout never invented a number and gave the same answer every time, but wrote prose
 *   into values: "2500 watts continuous @ 20 deg.C".
 * - Kimi K2.7 did both: every number on every page it read, none it made up, and the value, the
 *   unit and the part it belongs to kept apart.
 * - The text reader every other document goes through, given Kimi's transcriptions, called four
 *   burners "BTU" four times and found nothing in a table of seven lithium cells. So the figures
 *   are Kimi's too.
 *
 * Its reasoning is switched off, and every answer is held to a JSON schema: without one it thinks
 * aloud into the answer anyway, and ran out of room on a dense page before writing a word of it.
 */
export const VISION_MODEL = "@cf/moonshotai/kimi-k2.7-code";
/** The prompts and the picture they are shown. A change to any of them reads differently, so it is a new version. */
export const VISION_PROMPT_VERSION = "1";
/** An `ai:` reader like the text one, which the spec schema requires, and named apart from it. */
export const VISION_EXTRACTOR_ID = `ai:${VISION_MODEL}@vision-p${VISION_PROMPT_VERSION}`;
/** The page reader's transcription, as a converter: `archive/<sha256>.<this>.md`, beside `CONVERTER`'s. */
export const PAGE_CONVERTER = `pages-${VISION_MODEL.split("/").pop()}-p${VISION_PROMPT_VERSION}`;

/**
 * Pages one document's reading looks at. The longest scan held today is eighty pages, and a page
 * is under a cent — three thousand tokens of picture in, its transcription out, and a short read of
 * that — so the budget here is a guard against a scanned catalogue rather than a saving.
 */
export const MAX_PAGES = 80;

/**
 * The largest document a page is drawn from. PDFium holds the whole file in its memory and that
 * memory never shrinks: one 34 MB brochure left it at 71 MB, in an isolate allowed 128. Four of the
 * 365 scans are over this, and each is refused with the reason rather than risked.
 */
export const MAX_RENDER_BYTES = 16 * 1024 * 1024;

/** Characters of text per page below which a conversion is taken to have no text layer at all. */
export const TEXT_PER_PAGE = 50;

/**
 * How many pages a conversion has, and how much text is on them once the converter's own furniture
 * — the title, the metadata block, the page headings — is gone.
 */
export function textLayer(markdown: string): { pages: number; characters: number } {
  const at = markdown.indexOf("## Contents");
  const contents = at === -1 ? markdown : markdown.slice(at + "## Contents".length);
  const pages = pageOffsets(contents).length;
  return { pages, characters: contents.replace(PAGE_HEADING, "").replace(/\s+/g, "").length };
}

/**
 * Whether the text reader had anything to read. A conversion with no pages is not a PDF's, so there
 * is nothing to draw and the answer is yes; one with pages and almost no text on them is a scan.
 */
export function hasTextLayer({ pages, characters }: { pages: number; characters: number }): boolean {
  return pages === 0 || characters >= pages * TEXT_PER_PAGE;
}

export const TRANSCRIBE_SYSTEM = `You transcribe one page of a manufacturer's document, given as an image, into Markdown. The transcription is kept as the record of what the page says and figures are read from it afterwards, so a character copied wrong becomes a wrong figure: copy, never guess.

Write down every word and number printed on the page, in reading order, exactly as printed. Do not correct, summarise, translate, explain or complete anything. A character you cannot make out is written as it looks; a word you cannot read at all is written [illegible].

A table becomes a Markdown table, one row for each printed row, under the printed headings. Lines that pair a label with a value, such as "Weight ........ 42 lbs", become a two-column table of label and value.

Headings become Markdown headings. A photograph, drawing, diagram or chart is not transcribed: write one line in square brackets saying what it is, such as [photograph of the product] or [performance chart], and nothing read off it.

Answer with the Markdown in the "markdown" field, with no code fences and no remarks of your own.`;

/** The transcription, as one field: a schema is what keeps the model from thinking aloud into it. */
export const TRANSCRIPT_SCHEMA = { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] };

/**
 * The Markdown out of a transcription answer. Only a fence around the whole answer is taken off: a
 * search for the first fence anywhere would find one inside the page and return a piece of it. An
 * answer that is not the schema throws, since that is a failed call.
 */
export function transcriptOf(answer: string): string {
  const trimmed = answer.trim();
  const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  const { markdown } = JSON.parse(unfenced) as { markdown?: unknown };
  if (typeof markdown !== "string") throw new Error("the transcription came back without its markdown");
  return markdown;
}

/**
 * A page's own "Page 43" footer, written as a heading, would look like the converter's page
 * boundary and move every figure after it onto the wrong page. So it is kept as a line of text.
 */
export function withoutPageHeadings(markdown: string): string {
  return markdown.replace(/^#{1,6}\s*(Page\s+\d+)\s*$/gim, "$1");
}

/**
 * A scan's pages put together as a conversion of the whole document, in the shape `toMarkdown`
 * gives a PDF with text: a title, a metadata block, and a heading per page. Anything that reads a
 * conversion — the text reader's windows, the page each figure keeps — reads this one the same way.
 */
export function transcriptDocument(name: string, pages: { page: number; markdown: string }[]): string {
  const contents = pages.map((p) => `### Page ${p.page}\n\n${withoutPageHeadings(p.markdown).trim()}\n`).join("\n");
  return `# ${name}\n## Metadata\n- Converter=${PAGE_CONVERTER}\n\n## Contents\n${contents}`;
}

export const PAGE_FIGURES_SYSTEM = `You read one page of a manufacturer's document, transcribed into Markdown from a picture of the page, and report the rated figures it prints. A line in square brackets stands for a picture that was not transcribed.

The figures go into a public catalogue that people size power systems from, so a figure left out is better than a figure that is wrong.

Report only figures the page prints. Never calculate, convert, round or infer one. If the page prints no ratings, answer with an empty list.

MODEL. Give the model exactly as printed, and only for a single product. A family or a series — "MS Series", "CSW SERIES", "Tracer AN" — is not a model: if a table gives several products under one family, report each product separately under its own model. A specification sheet for one product names it in its title or its table; use that name. If you cannot tell which product a figure belongs to, do not report the figure.

VALUE. One figure, one value, kept exactly as printed, so "12/24" stays "12/24". Where one cell prints figures for several parts of one product — two outputs, four burners, three phases — report each as its own figure, named for its part. Where one figure is printed in two units, report it once, in the unit printed first.

UNIT. Every figure has a unit, and it is almost always on the page: printed after the number, or in the heading of the column or the label of the row the number sits in. A row labelled "Weight (kg)" gives its numbers the unit "kg". Put the unit in the unit field, never inside the name and never inside the value, and write an inch mark as "in". Leave the unit empty only for something that has none — a chemistry, a connector type, a protocol name, a yes or no.

CONDITIONS. What the figure is true under, when the page says: the discharge rate, the temperature, the bank voltage. A capacity without its rate is not a capacity.

Read every table on the page.

Do not report prices, warranty periods, part numbers, packaging weights, ordering codes or marketing claims.`;

/**
 * The text reader's answer with the unit made compulsory. Left optional, GLM found every figure on
 * a range's spec sheet and dropped every unit; required, it had to decide on one for each, and gave
 * the right one. The rule costs a model that fills units anyway nothing.
 */
export const VISION_RESPONSE_SCHEMA = figuresSchema(["name", "value", "unit"]);

/**
 * What a model said about one page, with that page on every figure. The page is the one that was
 * drawn, never one the model names: an invented page number is worse than none, because it looks
 * checkable. An answer that is not JSON throws, since that is a failed call rather than an empty page.
 */
export function reportsOnPage(answer: string, page: number): Reported[] {
  const parsed = JSON.parse(answer) as { products?: unknown };
  if (!Array.isArray(parsed.products)) return [];
  return (parsed.products as Reported[])
    .filter((product) => typeof product?.model === "string" && Array.isArray(product.specs))
    .map((product) => ({ model: product.model, specs: product.specs.map((s) => ({ ...s, page })) }));
}


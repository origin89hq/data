import { VISION_MODEL } from "@origin89/equipment-schema/provenance";
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
/**
 * A PDF is read from where its characters sit, which keeps the columns of its tables; anything else
 * is converted by the model as before. One id for one way of converting, so whatever reads a
 * document's text looks in one place.
 */
export const CONVERTER = "layout-v1";

/** What one document's conversion produced, or why it produced nothing. */
export interface Converted {
  sha256: string;
  url: string;
  key?: string;
  characters?: number;
  error?: string;
}

export {
  EXTRACT_MODEL,
  EXTRACT_PROMPT_VERSION,
  EXTRACTOR_ID,
} from "@origin89/equipment-schema/provenance";

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

UNIT. Give the unit on its own, not inside the name and not inside the value: "Rated capacity" with value "428" and unit "Ah", never "Rated Capacity (Ah)" with value "428 Ah". A unit printed once for a whole table, in a column header, a row heading or a note under the table — "Surge power (watts)", a column headed "W", "all currents in A DC" — belongs to every figure in that column or row: carry it into each figure's unit. A figure with no unit is only right for something that has none — a chemistry, a connector type, a protocol name, a yes or no. Never invent a unit the document does not print somewhere.

CONDITIONS. What the figure is true under, when the text says: the discharge rate, the temperature, the bank voltage. A capacity without its rate is not a capacity.

CHEMISTRY. For a battery, report its chemistry as a figure named "Chemistry" with the document's own words — "LiFePO4", "Lithium Iron Phosphate", "AGM", "Gel", "Flooded", "Lead-acid" — read from the title, the description or the table, wherever the document states it. It has no unit. Do not report one the document does not state.

THE MAKER'S OWN RATINGS. The message starts with the maker whose document this is. Report the ratings of that maker's own products only. Its documents also print what is not a rating of its products: settings it recommends for another company's battery, inverter or charger; values drawn on a screen, display or app in an illustration; the results of a worked example, a test or a demonstration; and the figures of another company's products listed beside its own. Leave those out.

THE SECTION IT IS PRINTED IN. The message may name the section of the document the window was taken from. Weigh it: a figure printed in a section about installing, wiring or mounting the product, about what an installer must choose or size, about what to set, program or select, or in a table the document calls a recommendation or says is for reference only, is a setting or an instruction, not a rating — however much it looks like one. A figure printed among specifications or technical data is a rating.

Do not report prices, warranty periods, part numbers, packaging weights, ordering codes or marketing claims.

ANSWER. Reply with JSON only, no prose: {"products":[{"model":"...","is":"...","specs":[{"name":"...","value":"...","unit":"...","conditions":"...","is":"..."}]}]}. Leave out a unit or conditions the text does not give. Say what each product is: "product" for one product of the maker, "family" for a series or for several products under one name, "kit" for a kit, bundle or system of several products, "other-maker" for another company's product. Say what each figure is: "rating" for a rated or specified figure of the product, "setting" for a default, a preset or a value the user sets, "instruction" for what an installer or user must provide or do, "test" for a test condition or an expected reading, "example" for an illustration, a screen or a worked example.`;

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

/** The answer the page reader is held to, with the fields of a figure it must fill. */
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
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                  unit: { type: "string" },
                  conditions: { type: "string" },
                },
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
  for (let m = PAGE_HEADING.exec(markdown); m; m = PAGE_HEADING.exec(markdown))
    out.push({ page: Number(m[1]), at: m.index });
  return out;
}

/**
 * Split a document into windows that overlap, so a ratings table straddling a boundary is seen
 * whole at least once, and carry the page each window starts on. A figure without a page is a
 * figure nobody can go back and check.
 */
export function chunk(
  markdown: string,
  size = CHUNK_CHARACTERS,
  overlap = CHUNK_OVERLAP,
): Window[] {
  const pages = pageOffsets(markdown);
  const pageAt = (offset: number): number | undefined => {
    let page: number | undefined;
    for (const p of pages) {
      if (p.at > offset) break;
      page = p.page;
    }
    return page;
  };
  if (markdown.length <= size)
    return markdown.trim()
      ? [{ text: markdown, ...(pageAt(0) === undefined ? {} : { page: pageAt(0) }) }]
      : [];
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

/**
 * The page a figure is printed on, from where its value sits in its window: the last page marker
 * before the value, or the page the window starts on when the value comes before the first marker
 * in it. A window is six thousand characters and can run over several pages, and citing the page it
 * starts on put a table lower in the window on an earlier page than the one that prints it (#148).
 *
 * A value printed on more than one page is taken where its name is printed on the same line, and
 * otherwise where it is printed first. A value not printed at all is looked for by its name, and a
 * figure whose value and name are both missing keeps the window's page. Before the first page,
 * in a document's title and metadata, nothing is printed on a page, so nothing there is taken.
 *
 * Only whitespace is forgiven, since the model folds a line break or a double space into one. A
 * value is found whole, so "12" is not found inside "120", "12.8" or "RM-12", though it is inside
 * "12V"; a looser match would put a figure on a page that does not print it.
 */
export function pageOfFigure(
  window: Window,
  figure: { name: string; value: string },
): number | undefined {
  const markers = pageOffsets(window.text);
  // A marker's own number is not a figure. Blanked with spaces, so every match keeps its place and
  // its line.
  const text = window.text.replace(PAGE_HEADING, (heading) => heading.replace(/[^\n]/g, " "));
  const onAPage = (words: string) =>
    printedAt(text, words).flatMap((at) => {
      const page = pageAt(markers, at) ?? window.page;
      return page === undefined ? [] : [{ at, page }];
    });
  const values = onAPage(figure.value);
  if (new Set(values.map((v) => v.page)).size > 1) {
    const named = values.find(({ at }) => {
      const end = text.indexOf("\n", at);
      const line = text.slice(text.lastIndexOf("\n", at) + 1, end === -1 ? undefined : end);
      return printedAt(line, figure.name).length > 0;
    });
    if (named) return named.page;
  }
  return (values[0] ?? onAPage(figure.name)[0])?.page ?? window.page;
}

/**
 * Where some words are printed in a text, with any run of whitespace in them matching any other.
 * They are found whole: not inside a longer word or number, and not joined to one by a hyphen or a
 * slash, which makes them part of a name, a range or a fraction. A unit may follow a number.
 */
/**
 * Whether a window prints a value the reader reported. A value it did not read off the window is not
 * a figure of this document: a chemistry taken from the kind of product, a number from outside the
 * window. Every number in the value has to be printed, however the document writes it — "1000" as
 * "1,000", "13.8" as "13,8", "12" as "12.0" — and a value with no number is found by its letters and
 * digits run together, so spacing, case and punctuation do not matter. A value with neither, such as
 * a tick, cannot be looked for and is kept.
 */
export function printsValue(text: string, value: string): boolean {
  const spellings = (number: string): string[] => {
    const point = number.replace(/,/g, ".");
    const bare = number.replace(/[.,](?=\d{3}(?!\d))/g, "");
    return [number, point, bare, bare.replace(/,/g, "."), number.replace(/[.,]/g, "")].flatMap(
      (n) => [n, n.replace(/\.0+$/, "")],
    );
  };
  // "10¼" is ten and a quarter, which NFKC would write "101⁄4": the fraction is set apart first.
  const numbersIn = (s: string) =>
    s
      .replace(/(\d)(?=[\u00BC-\u00BE\u2150-\u215E])/g, "$1 ")
      .normalize("NFKC")
      .match(/\d+(?:[.,]\d+)*/g) ?? [];
  const wanted = numbersIn(value);
  if (wanted.length > 0) {
    const printed = new Set(numbersIn(text).flatMap(spellings));
    return wanted.every((number) => spellings(number).some((n) => printed.has(n)));
  }
  const letters = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const words = letters(value);
  return !words || letters(text).includes(words);
}

function printedAt(text: string, words: string): number[] {
  const trimmed = words.trim();
  if (!trimmed) return [];
  const body = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const before = /^\w/.test(trimmed) ? "(?<!\\w|\\d[.,]|\\w[-/])" : "";
  const after = /\d$/.test(trimmed)
    ? "(?![\\d_]|[.,]\\d|[-/]\\w)"
    : /\w$/.test(trimmed)
      ? "(?!\\w|[-/]\\w)"
      : "";
  return [...text.matchAll(new RegExp(`${before}${body}${after}`, "g"))].map((m) => m.index ?? 0);
}

/**
 * Symbols the text reader writes back as something else (#145): Volthium's manual prints "≥8000
 * cycles" and the reading said "£8000 cycles". The window is shown to the model with them spelled
 * in ASCII, and what it reports is given "≥" and "≤" back where its document prints them, so a
 * figure keeps the symbol its document prints. "～" stays "~", which the records read the same way
 * in a range.
 */
const SPELLED: readonly (readonly [symbol: string, ascii: string])[] = [
  ["≥", ">="],
  ["≤", "<="],
  ["～", "~"],
];

/** A window's text with the symbols the reader garbles spelled in ASCII. */
export function asciiSymbols(text: string): string {
  return SPELLED.reduce((out, [symbol, ascii]) => out.replaceAll(symbol, ascii), text);
}

/**
 * What the reader reported, with "≥" and "≤" given back where the text it was shown prints them. A
 * sheet can print ">=" itself, so words found as printed keep their operators; words found neither
 * way are given the symbols only if the text has no ASCII operator the model could have copied.
 */
export function printedSymbols(printed: string, reported: string): string {
  const symbols = reported.replaceAll(">=", "≥").replaceAll("<=", "≤");
  if (symbols === reported || printedAt(printed, symbols).length > 0) return symbols;
  if (printedAt(printed, reported).length > 0 || /[<>]=/.test(printed)) return reported;
  return symbols;
}

/** Where a JSON object starts: a brace and then its first key, which is quoted, or its end. */
const OBJECT_START = /\{\s*["}]/y;

/**
 * The JSON objects an answer holds, in order, with the text around them left out. Held to no
 * schema, the model sometimes writes a note after its answer, fences it, or gives an empty answer
 * and then the one it meant, and parsing the whole text failed that window on every attempt. Braces
 * that do not open on a quoted key are prose and are passed over. An object cut short or malformed,
 * or an answer with no object at all, throws as `JSON.parse` does, so the window is read again
 * rather than read as empty.
 */
export function answerObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let start = text.indexOf("{");
  while (start >= 0) {
    OBJECT_START.lastIndex = start;
    if (!OBJECT_START.test(text)) {
      start = text.indexOf("{", start + 1);
      continue;
    }
    const end = objectEnd(text, start);
    // Still open at the end of the text, the object was cut short, and parsing it says so.
    objects.push(JSON.parse(end < 0 ? text.slice(start) : text.slice(start, end + 1)));
    start = end < 0 ? -1 : text.indexOf("{", end + 1);
  }
  if (objects.length === 0) JSON.parse(text);
  return objects;
}

/** Where the object opening at `start` closes, counting brackets outside strings, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      depth += 1;
    } else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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
      const same = existing.specs.findIndex(
        (x) =>
          `${x.name.trim().toLowerCase()}|${x.value.trim()}|${(x.conditions ?? "").trim().toLowerCase()}` ===
          seen,
      );
      if (same !== -1) {
        // Two overlapping windows can report one figure, and only the later may have been able to
        // tell its page. A page found is kept, whichever window found it.
        const kept = existing.specs[same];
        if (kept && kept.page === undefined && s.page !== undefined)
          existing.specs[same] = { ...kept, page: s.page };
        continue;
      }
      existing.specs.push(s);
    }
    byModel.set(key, existing);
  }
  return [...byModel.values()]
    .filter((r) => r.specs.length > 0)
    .sort((a, b) => a.model.localeCompare(b.model));
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
 * So this reader draws each page and a model that reads pictures writes it down as Markdown. The
 * pages are put together into a conversion of the whole document beside the one `toMarkdown` made,
 * and the same model reads the figures out of that, a window of the document at a time. The
 * transcription is kept, so a scan can be read again by any later reader without looking at a
 * picture, and a figure can be checked against the text it came from and that text against the page.
 *
 * The figures were read page by page once, and a page does not always name what it rates: a
 * certificate named its product on page 1 and gave its ratings on page 2, where the only code left
 * to use was the form number in the footer (#28).
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
export {
  VISION_EXTRACTOR_ID,
  VISION_MODEL,
  VISION_PROMPT_VERSION,
} from "@origin89/equipment-schema/provenance";
/**
 * The transcription's own version. It is kept apart from the figures prompt's, so a better way of
 * reading figures reads the transcripts already made instead of drawing every page again.
 * 3: a transcript names the pages it could not write down; one from before would pass off those
 * pages as blank, so it is not reused.
 */
export const TRANSCRIBE_VERSION = "3";

/** The page reader's transcription, as a converter: `archive/<sha256>.<this>.md`, beside `CONVERTER`'s. */
export const PAGE_CONVERTER = `pages-${VISION_MODEL.split("/").pop()}-p${TRANSCRIBE_VERSION}`;

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
export function hasTextLayer({
  pages,
  characters,
}: {
  pages: number;
  characters: number;
}): boolean {
  return pages === 0 || characters >= pages * TEXT_PER_PAGE;
}

export const TRANSCRIBE_SYSTEM = `You transcribe one page of a manufacturer's document, given as an image, into Markdown. The transcription is kept as the record of what the page says and figures are read from it afterwards, so a character copied wrong becomes a wrong figure: copy, never guess.

Write down every word and number printed on the page, in reading order, exactly as printed. Do not correct, summarise, translate, explain or complete anything. A character you cannot make out is written as it looks; a word you cannot read at all is written [illegible].

A table becomes a Markdown table, one row for each printed row, under the printed headings. Lines that pair a label with a value, such as "Weight ........ 42 lbs", become a two-column table of label and value.

Headings become Markdown headings. A photograph, drawing, diagram or chart is not transcribed: write one line in square brackets saying what it is, such as [photograph of the product] or [performance chart], and nothing read off it.

Answer with the Markdown in the "markdown" field, with no code fences and no remarks of your own.`;

/** The transcription, as one field: a schema is what keeps the model from thinking aloud into it. */
export const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: { markdown: { type: "string" } },
  required: ["markdown"],
};

/**
 * The Markdown out of a transcription answer. Only a fence around the whole answer is taken off: a
 * search for the first fence anywhere would find one inside the page and return a piece of it. An
 * answer that is not the schema throws, since that is a failed call.
 */
export function transcriptOf(answer: string): string {
  const trimmed = answer.trim();
  const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  const { markdown } = JSON.parse(unfenced) as { markdown?: unknown };
  if (typeof markdown !== "string")
    throw new Error("the transcription came back without its markdown");
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
export function transcriptDocument(
  name: string,
  pages: { page: number; markdown: string; failed?: string }[],
): string {
  const contents = pages
    .map((p) => `### Page ${p.page}\n\n${withoutPageHeadings(p.markdown).trim()}\n`)
    .join("\n");
  // A page left blank because it could not be drawn or written down says so, or its emptiness
  // would read as a page with nothing on it.
  const failed = pages.filter((p) => p.failed).map((p) => p.page);
  const missing = failed.length > 0 ? `- Not transcribed=${failed.join(", ")}\n` : "";
  return `# ${name}\n## Metadata\n- Converter=${PAGE_CONVERTER}\n${missing}\n## Contents\n${contents}`;
}

/** The pages a transcript says it could not write down. */
export function notTranscribed(transcript: string): number[] {
  const line = /^- Not transcribed=(.*)$/m.exec(transcript)?.[1] ?? "";
  return line
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0);
}

/**
 * Reading figures out of a whole transcript. Checked against the three documents that went wrong
 * page by page (#28): Kinetic Solar's certificate now gives its load ratings to K-Rack rather than
 * to the form number in its footer, Victron's gives "MultiPlus-II 48/3000/35-32 GX 230V" rather
 * than the model row alone, and a G99 annex gives no harmonic measurements as ratings.
 */
export const DOCUMENT_FIGURES_SYSTEM = `You read a manufacturer's document, transcribed into Markdown from pictures of its pages, and report the rated figures it prints for each product. Each page starts with a "### Page N" heading. A line in square brackets stands for a picture that was not transcribed.

The figures go into a public catalogue that people size power systems from, so a figure left out is better than a figure that is wrong.

Report only figures the document prints. Never calculate, convert, round or infer one. If it prints no ratings, answer with an empty list.

MODEL. Name the single product the figures belong to, as the document prints it. The name may be printed away from the figures: on the first page, in a title or heading, or in the row or column heading of a table. Put together a name the document splits: a table whose "Family" row reads "MultiPlus-II" and whose "Model" row reads "48/3000/35-32 230V" names the product "MultiPlus-II 48/3000/35-32 230V". A family or a series on its own is not a product; when a table gives several products of one family, report each under its own full name. These are never product names: a form, certificate, report, project, file or document number; a page header or footer; a heading that stands for a range, such as "xx/3000". If you cannot tell which single product a figure belongs to, do not report the figure.

RATINGS, NOT RESULTS. Report what the maker states the product is rated for. A certificate or test report also prints what was measured during a test — harmonic currents, values measured at a given load, trip times, pass or fail. Those are results, not ratings: leave them out.

THE MAKER'S OWN RATINGS. The message starts with the maker whose document this is. Report the ratings of that maker's own products only. Its documents also print what is not a rating of its products: settings it recommends for another company's battery, inverter or charger; values drawn on a screen, display or app in an illustration; the results of a worked example or a demonstration; and the figures of another company's products listed beside its own. Leave those out.

VALUE. One figure, one value, kept exactly as printed, so "12/24" stays "12/24". Where one cell prints figures for several parts of one product — two outputs, four burners, three phases — report each as its own figure, named for its part. Where one figure is printed in two units, report it once, in the unit printed first.

UNIT. Every figure has a unit, and it is almost always in the document: printed after the number, or in the heading of the column or the label of the row the number sits in. A row labelled "Weight (kg)" gives its numbers the unit "kg". Put the unit in the unit field, never inside the name and never inside the value, and write an inch mark as "in". Leave the unit empty only for something that has none — a chemistry, a connector type, a protocol name, a yes or no.

CONDITIONS. What the figure is true under, when the document says: the discharge rate, the temperature, the bank voltage. A capacity without its rate is not a capacity.

CHEMISTRY. For a battery, report its chemistry as a figure named "Chemistry" with the document's own words — "LiFePO4", "Lithium Iron Phosphate", "AGM", "Gel", "Flooded", "Lead-acid" — read from the title, the description or the table, wherever the document prints it. It has no unit. Do not report one the document does not print.

Read every table.

Do not report prices, warranty periods, part numbers, packaging weights, ordering codes or marketing claims.`;

/**
 * The text reader's answer with the unit made compulsory. Left optional, GLM found every figure on
 * a range's spec sheet and dropped every unit; required, it had to decide on one for each, and gave
 * the right one. The rule costs a model that fills units anyway nothing.
 */
export const VISION_RESPONSE_SCHEMA = figuresSchema(["name", "value", "unit"]);

/** The answer the text reader is held to. Kimi writes its thinking into an answer held to none. */
export const PRODUCT_LABELS = ["product", "family", "kit", "other-maker"] as const;
export const FIGURE_LABELS = ["rating", "setting", "instruction", "test", "example"] as const;

/**
 * The answer the text reader is held to: each product and each figure labelled for what it is, so
 * the reading keeps ratings of products and nothing else. Asked to leave the rest out, the model
 * still reported it; asked to say what each one is, it tells them apart (#196).
 */
export const TEXT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          model: { type: "string" },
          is: { type: "string", enum: PRODUCT_LABELS },
          specs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "string" },
                unit: { type: "string" },
                conditions: { type: "string" },
                is: { type: "string", enum: FIGURE_LABELS },
              },
              required: ["name", "value", "is"],
            },
          },
        },
        required: ["model", "is", "specs"],
      },
    },
  },
  required: ["products"],
};

/**
 * How much of a transcript one call reads. Big, because a product's name and its ratings can sit
 * pages apart: forty thousand characters is a dozen transcribed pages, which covers every
 * certificate and specification sheet held today in one call and a long manual in a few.
 */
export const FIGURE_WINDOW_CHARACTERS = 40_000;
export const FIGURE_WINDOW_OVERLAP = 2_000;

/** The start of a document, sent with every window after the first for the names it prints. */
export const DOCUMENT_HEAD_CHARACTERS = 3_000;

/** One window of a transcript: its text, where it starts, and the page it starts on. */
export interface FigureWindow extends Window {
  start: number;
  /**
   * For part of a window split in two: the window's text before this part, sent for the names
   * printed there. A product named early in a window and rated late stays named.
   */
  before?: { text: string; start: number };
}

/** A transcript's windows for figures, overlapping so a table on a boundary is read whole once. */
export function figureWindows(
  transcript: string,
  size = FIGURE_WINDOW_CHARACTERS,
  overlap = FIGURE_WINDOW_OVERLAP,
): FigureWindow[] {
  const pages = pageOffsets(transcript);
  const out: FigureWindow[] = [];
  for (let start = 0; start < transcript.length; start += size - overlap) {
    const text = transcript.slice(start, start + size);
    const page = pageAt(pages, start);
    if (text.trim()) out.push({ text, start, ...(page === undefined ? {} : { page }) });
    if (start + size >= transcript.length) break;
  }
  return out;
}

/** Below twice this a window is not halved again: an answer cut short that small is a failed call. */
export const SMALLEST_WINDOW = 5_000;

/**
 * A window in two, overlapping as windows do, for an answer that ran out of room: half the window
 * is about half the figures to write out. The answer was too long, not the question, so the second
 * half still carries everything before it in the window, for the names printed there.
 */
export function halves(transcript: string, window: FigureWindow): [FigureWindow, FigureWindow] {
  const pages = pageOffsets(transcript);
  const middle = Math.ceil(window.text.length / 2);
  const overlap = Math.min(FIGURE_WINDOW_OVERLAP, Math.floor(middle / 4));
  const part = (from: number, to: number): FigureWindow => {
    const start = window.start + from;
    const page = pageAt(pages, start);
    return { text: window.text.slice(from, to), start, ...(page === undefined ? {} : { page }) };
  };
  const first = {
    ...part(0, middle + overlap),
    ...(window.before ? { before: window.before } : {}),
  };
  const second: FigureWindow = {
    ...part(middle - overlap, window.text.length),
    before: {
      text: (window.before?.text ?? "") + window.text.slice(0, middle - overlap),
      start: window.before?.start ?? window.start,
    },
  };
  return [first, second];
}

function pageAt(pages: { page: number; at: number }[], offset: number): number | undefined {
  let page: number | undefined;
  for (const p of pages) {
    if (p.at > offset) break;
    page = p.page;
  }
  return page;
}

const CONTENTS = "\n## Contents\n";

/**
 * A line whose label says it names the product: a table row or a "**Label:**" line starting with
 * model, family, series, type, product, name, part number or SKU, or a heading that does.
 */
const NAMES_THE_PRODUCT =
  /^\s*(?:#{1,6}\s*|\|\s*)?(?:\*\*)?\s*(?:model|family|series|type|product|name|part(?:\s*(?:no\.?|number))?|sku)\b/i;

/**
 * What the model is given for one window: the window, and the document's start when it is not in
 * it. Neither carries the transcript's title or metadata. The title is the file's name from its
 * URL, not anything the document prints, and the prompt lets a title name a product: a scan saved
 * as "RM-12-spec-sheet.pdf" could have lent its figures a model its pages never print.
 */
export function windowPrompt(transcript: string, window: FigureWindow): string {
  const at = transcript.indexOf(CONTENTS);
  const pages = at === -1 ? 0 : at + CONTENTS.length;
  if (window.start === 0) return window.text.slice(pages);
  // What comes before this part, when it is half of a window; from the pages on, never the title.
  const before = window.before
    ? window.before.text.slice(Math.max(0, pages - window.before.start))
    : "";
  // The document's start, unless what comes before already begins there.
  const head =
    (window.before?.start ?? window.start) <= pages
      ? ""
      : `The document begins:\n\n${transcript.slice(pages, pages + DOCUMENT_HEAD_CHARACTERS)}\n\n[…]\n\n`;
  const earlier = before ? `What comes just before this part:\n\n${before}\n\n` : "";
  return `${head}${earlier}Report the figures in this part of it:\n\n${window.text}`;
}

/**
 * What the model said about one window, each figure given the page its value is printed on. The
 * page is found by looking for the value in the window's own text, never taken from the model: an
 * invented page number is worse than none, because it looks checkable. A value found on no page,
 * or on more than one, gets no page rather than the first place it happens to appear. An answer
 * that is not JSON throws, since that is a failed call rather than a window with nothing in it.
 */
export function reportsInWindow(
  answer: string,
  transcript: string,
  window: FigureWindow,
): Reported[] {
  const parsed = JSON.parse(answer) as { products?: unknown };
  if (!Array.isArray(parsed.products)) return [];
  const products = (parsed.products as Reported[]).filter(
    (product) => typeof product?.model === "string" && Array.isArray(product.specs),
  );
  const pages = pageOffsets(transcript);
  // Every product name the answer gives, blanked out of the window where it is printed, so a
  // value is never found inside a name: "12" in "RM 12" as much as in "RM-12". Blanked with as
  // many spaces, so every other match keeps its place.
  let searched = window.text;
  for (const { model } of products) {
    const name = model.trim();
    if (!name) continue;
    const printed = new RegExp(
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
      "gi",
    );
    searched = searched.replace(printed, (match) => " ".repeat(match.length));
  }
  // And the document's own page numbers: the "2" of a footer's "Page 2 of 4" is not a rating,
  // wherever on its line the footer sits.
  searched = searched.replace(/\bpage\s+\d+(?:\s*(?:of|\/)\s*\d+)?/gi, (match) =>
    " ".repeat(match.length),
  );
  const pageOf = (value: string): number | undefined => {
    const needle = value.trim();
    if (!needle) return undefined;
    // The value as a whole figure, so "1" is not found inside "10" or "1.5", and "12" not inside
    // "RM-12" or "3000" inside "48/3000/35-32": a hyphen or a slash joining it to a word makes it
    // part of a name, a range or a fraction. A figure that is only there gets no page.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const figure = new RegExp(`(?<![\\w.])(?<!\\w[-/])${escaped}(?![\\w]|\\.\\d|[-/]\\w)`, "g");
    const found = new Set<number>();
    for (const match of searched.matchAll(figure)) {
      const at = window.start + (match.index ?? 0);
      // Not the title or metadata before the first page, and not a "### Page N" heading.
      const line = transcript.slice(
        transcript.lastIndexOf("\n", at - 1) + 1,
        transcript.indexOf("\n", at) === -1 ? undefined : transcript.indexOf("\n", at),
      );
      if (/^#{1,6}\s*Page\s+\d+\s*$/i.test(line)) continue;
      // Nor a row or a label that names the product. The prompt puts a name together from a
      // "Family" row and a "Model" row, and the "12" of "| Model | 12 |" is part of that name, never
      // a rating printed there.
      if (NAMES_THE_PRODUCT.test(line)) continue;
      const page = pageAt(pages, at);
      if (page !== undefined) found.add(page);
    }
    // Printed on one page only, or no page: a value printed on two cannot say which one it came from.
    return found.size === 1 ? [...found][0] : undefined;
  };
  return products.map((product) => ({
    model: product.model,
    // A null or a bare string among a product's figures is dropped, not a reason to lose the
    // window: `strict: false` lets the model answer outside the schema.
    specs: product.specs
      .filter((s) => typeof s === "object" && s !== null)
      .map((s) => {
        const { page: _claimed, ...figure } = s;
        const page = typeof s.value === "string" ? pageOf(s.value) : undefined;
        return { ...figure, ...(page === undefined ? {} : { page }) };
      }),
  }));
}

import { answerText, contentOf } from "./classify.ts";
import { makerName } from "./manufacturers.ts";
import {
  CONVERTER,
  DOCUMENT_FIGURES_SYSTEM,
  type FigureWindow,
  figureWindows,
  halves,
  hasTextLayer,
  MAX_PAGES,
  MAX_RENDER_BYTES,
  mergeReports,
  notTranscribed,
  PAGE_CONVERTER,
  type Reported,
  reportsInWindow,
  SMALLEST_WINDOW,
  TRANSCRIBE_SYSTEM,
  TRANSCRIPT_SCHEMA,
  textLayer,
  transcriptDocument,
  transcriptOf,
  VISION_EXTRACTOR_ID,
  VISION_MODEL,
  VISION_RESPONSE_SCHEMA,
  windowPrompt,
} from "./reading.ts";
import { type Pdfium, png, pngDataUrl, renderPage } from "./render.ts";
import { LAST_ATTEMPT, partKey, readerKey, sendAll, type Work } from "./work.ts";

/**
 * The page reader's steps: decide whether a document needs its pages looked at, write each page
 * down, and once every page is written down, read the figures out of the whole transcript a window
 * at a time. Kept out of the queue handler, which passes PDFium in, so they can be run in a test
 * against the same PDFium binary the Worker uses.
 */

type VisionDocument = Extract<Work, { kind: "vision" }>;
type VisionPage = Extract<Work, { kind: "vision-page" }>;
type VisionWindow = Extract<Work, { kind: "vision-window" }>;

/** What one page gave: what it says, or why it says nothing. */
export interface SeenPage {
  page: number;
  /** The page written down; empty when it could not be drawn or transcribed. */
  markdown: string;
  failed?: string;
}

/** What one window of a transcript gave: the figures read out of it, or why there are none. */
export interface ReadWindow {
  window: number;
  products: Reported[];
  failed?: string;
}

/** The figures reader: its windows and its reading are keyed by it. */
const READER = readerKey(VISION_EXTRACTOR_ID);
/**
 * The transcription: its pages and the transcript are keyed by it, not by the figures reader, so a
 * new way of reading figures reads the transcripts already made.
 */
const TRANSCRIBER = PAGE_CONVERTER;
const AS_JSON = { httpMetadata: { contentType: "application/json" } };
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
// Kimi's own name for the switch: `enable_thinking`, which other models take, it ignores.
const QUIETLY = { temperature: 0, chat_template_kwargs: { thinking: false } };

/**
 * The model, or the page reader's own pace, said not yet. The page or window goes back on the queue
 * to wait its turn, and the refusal is not written down as its answer. Retried at once, all four
 * deliveries of a page fell inside one minute of Kimi's limit, and 1,996 of 2,148 pages were kept
 * as failed (#29).
 */
class NotYet extends Error {}

/** Workers AI's answer when an account is over a model's requests per minute. */
const rateLimited = (error: unknown): boolean => /\b3021\b/.test(reason(error));

/**
 * Times a page or window is put back before a refusal counts as a failure like any other. Thirty
 * waits, most of them at the half-hour cap, is about half a day: longer than the whole backlog of
 * scans takes at the page reader's pace, and still an end for one the model never serves.
 */
export const MAX_WAITS = 30;

/**
 * How long a page or window waits before it is tried again: a minute, doubling to half an hour,
 * and up to a minute more by its place, so a document's pages turned away together do not all come
 * back together.
 */
export function waitFor(message: VisionPage | VisionWindow): number {
  const waits = message.waits ?? 0;
  const place = message.kind === "vision-page" ? message.page : message.window;
  const spread = (Number.parseInt(message.sha256.slice(0, 4), 16) + place) % 60;
  return Math.min(60 * 2 ** waits, 1800) + spread;
}

/** A turn with the model, asked before any work: one check for a page or window turned away. */
async function takeTurn(env: Env, message: VisionPage | VisionWindow): Promise<boolean> {
  // Past its last wait nothing is held back any more: whatever the model says next is the answer.
  const mayWait = (message.waits ?? 0) < MAX_WAITS;
  if (mayWait && !(await env.PAGE_READER_PACE.limit({ key: VISION_MODEL })).success)
    throw new NotYet("over the page reader's pace");
  return mayWait;
}

/** Put a page or window back on the queue to wait its turn, and say why in the logs. */
async function waitTurn(
  env: Env,
  message: VisionPage | VisionWindow,
  error: NotYet,
): Promise<void> {
  // Logged with its reason, so the logs say how often Kimi itself still refused. The pace is
  // counted per Cloudflare location, and a refusal past it is how that would show.
  console.log(
    JSON.stringify({
      message: `${message.kind === "vision-page" ? "page" : "window"} waits its turn`,
      sha256: message.sha256,
      ...(message.kind === "vision-page" ? { page: message.page } : { window: message.window }),
      waits: (message.waits ?? 0) + 1,
      reason: error.message,
    }),
  );
  // A new message rather than a retry, so waiting its turn does not use up the deliveries it gets
  // for failures of its own.
  await env.WORK.send(
    { ...message, waits: (message.waits ?? 0) + 1 },
    { delaySeconds: waitFor(message) },
  );
}

/**
 * Whether a converted document needs its pages looked at, and if it does, one message per page.
 * A document whose pages were written down before goes straight to having its figures read.
 */
export async function seeDocument(message: VisionDocument, env: Env): Promise<void> {
  const reading = partKey.reading(message.sha256, READER);
  if (await env.ARCHIVE.head(reading)) return;
  const transcribed = await env.ARCHIVE.get(partKey.markdown(message.sha256, TRANSCRIBER));
  if (transcribed) {
    const transcript = await transcribed.text();
    const windows = windowsOf(transcript);
    if (windows > 0) await sendWindows(message, env, windows);
    else await writeReading(message, env, transcript, []);
    return;
  }
  // The converter's markdown says whether there is anything to see. A document it could not
  // convert — a ZIP of logos, a damaged file — has no markdown, and no pages to draw either.
  const markdown = await env.ARCHIVE.get(partKey.markdown(message.sha256, CONVERTER));
  if (!markdown) return;
  const layer = textLayer(await markdown.text());
  if (hasTextLayer(layer)) return;
  const source = await env.ARCHIVE.head(`archive/${message.sha256}`);
  if (!source) throw new Error(`archive/${message.sha256} is not in the archive`);
  if (source.size > MAX_RENDER_BYTES) {
    // The refusal is this reader's answer about the document, so it is written where the reading
    // would be: offering it again tomorrow would get the same answer.
    const refused = `${(source.size / 2 ** 20).toFixed(1)} MB, over the ${MAX_RENDER_BYTES / 2 ** 20} MB a page is drawn from`;
    await env.ARCHIVE.put(
      reading,
      `${JSON.stringify({ sha256: message.sha256, url: message.url, products: [], pages: 0, failed: 0, refused, extractedBy: VISION_EXTRACTOR_ID })}\n`,
      AS_JSON,
    );
    return;
  }
  const pages = Math.min(layer.pages, MAX_PAGES);
  if (layer.pages > MAX_PAGES)
    console.log(
      JSON.stringify({
        message: "reading the first pages only",
        sha256: message.sha256,
        pages: layer.pages,
        reading: pages,
      }),
    );
  const { run, manufacturer, date, sha256, url } = message;
  await sendAll(
    env.WORK,
    Array.from(
      { length: pages },
      (_, i): Work => ({
        kind: "vision-page",
        run,
        manufacturer,
        date,
        sha256,
        url,
        page: i + 1,
        pages,
      }),
    ),
  );
}

/** One page: drawn and written down once, then put together with the others if it was the last to land. */
export async function seePage(
  message: VisionPage,
  env: Env,
  attempt: number,
  library: () => Promise<Pdfium>,
): Promise<void> {
  if (await env.ARCHIVE.head(partKey.markdown(message.sha256, TRANSCRIBER))) return;
  const key = partKey.page(message.sha256, TRANSCRIBER, message.page);
  if (!(await env.ARCHIVE.head(key))) {
    let seen: SeenPage;
    try {
      seen = await transcribePage(message, env, attempt, library);
    } catch (error) {
      if (!(error instanceof NotYet)) throw error;
      await waitTurn(env, message, error);
      return;
    }
    await env.ARCHIVE.put(key, `${JSON.stringify(seen)}\n`, AS_JSON);
  }
  await gatherPages(message, env);
}

/** Draw one page and write down what it says. */
async function transcribePage(
  message: VisionPage,
  env: Env,
  attempt: number,
  library: () => Promise<Pdfium>,
): Promise<SeenPage> {
  const { page } = message;
  const mayWait = await takeTurn(env, message);
  const source = await env.ARCHIVE.get(`archive/${message.sha256}`);
  if (!source) throw new Error(`archive/${message.sha256} is not in the archive`);
  const pdfium = await library();
  let image: string;
  try {
    const drawn = renderPage(pdfium, new Uint8Array(await source.arrayBuffer()), page);
    image = pngDataUrl(await png(drawn.width, drawn.height, drawn.rgb));
  } catch (error) {
    // A page PDFium cannot draw will not draw on the next attempt either.
    return { page, markdown: "", failed: `not drawn: ${reason(error)}` };
  }
  try {
    const response = await env.AI.run(VISION_MODEL, {
      messages: [
        { role: "system", content: TRANSCRIBE_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this page." },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "page", schema: TRANSCRIPT_SCHEMA, strict: false },
      },
      max_tokens: 6000,
      ...QUIETLY,
    } as never);
    return { page, markdown: transcriptOf(answerText(response)) };
  } catch (error) {
    if (mayWait && rateLimited(error)) throw new NotYet(reason(error));
    // A model call fails for reasons that pass, so the queue tries it again. On the last attempt the
    // failure is written down instead: one page that never lands would hold the reading back for ever.
    if (attempt < LAST_ATTEMPT) throw error;
    return { page, markdown: "", failed: `not transcribed: ${reason(error)}` };
  }
}

/**
 * Put a document's pages together once every one is in, as a conversion beside `toMarkdown`'s, and
 * send its windows to be read. Whichever page lands last does it; two landing at once both do, and
 * write the same bytes, because the pages are put together in page order.
 */
async function gatherPages(message: VisionPage, env: Env): Promise<void> {
  const listed = await env.ARCHIVE.list({
    prefix: partKey.pages(message.sha256, TRANSCRIBER),
    limit: 1000,
  });
  const pages = (
    await Promise.all(
      listed.objects.map(async (object) => (await env.ARCHIVE.get(object.key))?.json<SeenPage>()),
    )
  )
    .filter((page): page is SeenPage => page !== undefined && page.page <= message.pages)
    .sort((a, b) => a.page - b.page);
  if (pages.length < message.pages) return;
  const name = new URL(message.url).pathname.split("/").pop() || message.sha256;
  const transcript = transcriptDocument(name, pages);
  // What follows from the transcript is done before it is written: its windows sent, a window that
  // comes in first waiting for it, or with nothing to read, its reading written. Written first, the
  // transcript stopped every later delivery of a page, so a send or a write that failed after it
  // left the document with no windows, or no reading, and nothing to try them again.
  const windows = windowsOf(transcript);
  if (windows > 0) await sendWindows(message, env, windows);
  else await writeReading(message, env, transcript, []);
  await env.ARCHIVE.put(partKey.markdown(message.sha256, TRANSCRIBER), transcript, {
    httpMetadata: { contentType: "text/markdown" },
  });
}

/**
 * How many windows a transcript is read in: none when no page of it was written down, since its
 * title and page headings are not worth a call.
 */
function windowsOf(transcript: string): number {
  return textLayer(transcript).characters === 0 ? 0 : figureWindows(transcript).length;
}

/** One message per window of a transcript. */
async function sendWindows(
  message: VisionDocument | VisionPage,
  env: Env,
  windows: number,
): Promise<void> {
  const { run, manufacturer, date, sha256, url } = message;
  await sendAll(
    env.WORK,
    Array.from(
      { length: windows },
      (_, i): Work => ({
        kind: "vision-window",
        run,
        manufacturer,
        date,
        sha256,
        url,
        window: i + 1,
        windows,
      }),
    ),
  );
}

/** One window: read once for figures, then put together with the others if it was the last to land. */
export async function seeWindow(message: VisionWindow, env: Env, attempt: number): Promise<void> {
  if (await env.ARCHIVE.head(partKey.reading(message.sha256, READER))) return;
  const key = partKey.window(message.sha256, READER, message.window);
  if (!(await env.ARCHIVE.head(key))) {
    let read: ReadWindow;
    try {
      read = await readWindow(message, env, attempt);
    } catch (error) {
      if (!(error instanceof NotYet)) throw error;
      await waitTurn(env, message, error);
      return;
    }
    await env.ARCHIVE.put(key, `${JSON.stringify(read)}\n`, AS_JSON);
  }
  await gatherWindows(message, env);
}

/** Read the figures out of one window of the transcript, with the document's start for its names. */
async function readWindow(message: VisionWindow, env: Env, attempt: number): Promise<ReadWindow> {
  // Windows are sent before the transcript is written, so one can come in first. It waits, as for
  // its turn with the model, and costs no turn.
  const object = await env.ARCHIVE.get(partKey.markdown(message.sha256, TRANSCRIBER));
  if (!object) {
    if ((message.waits ?? 0) < MAX_WAITS) throw new NotYet("the transcript is not written yet");
    throw new Error(`the transcript of ${message.sha256} is not in the archive`);
  }
  const mayWait = await takeTurn(env, message);
  const transcript = await object.text();
  const window = figureWindows(transcript)[message.window - 1];
  if (!window) return { window: message.window, products: [] };
  try {
    return { window: message.window, products: await figuresIn(env, message, transcript, window) };
  } catch (error) {
    // A half turned away by the pace: the window waits its turn, and is read again whole.
    if (error instanceof NotYet) throw error;
    if (mayWait && rateLimited(error)) throw new NotYet(reason(error));
    if (attempt < LAST_ATTEMPT) throw error;
    return { window: message.window, products: [], failed: `not read: ${reason(error)}` };
  }
}

/**
 * The figures the model reads in one window. An answer that is not JSON has most often run out of
 * room on a dense window, and discarding it lost the whole window. So the window is read again as
 * two halves, each its own call and its own turn with the model, down to a size where an answer cut
 * short is simply a failed call.
 */
async function figuresIn(
  env: Env,
  message: VisionWindow,
  transcript: string,
  window: FigureWindow,
): Promise<Reported[]> {
  const response = await env.AI.run(VISION_MODEL, {
    messages: [
      { role: "system", content: DOCUMENT_FIGURES_SYSTEM },
      {
        role: "user",
        content: `Maker: ${makerName(message.manufacturer)}\n\n${windowPrompt(transcript, window)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "figures", schema: VISION_RESPONSE_SCHEMA, strict: false },
    },
    max_tokens: 6000,
    ...QUIETLY,
  } as never);
  try {
    return reportsInWindow(contentOf(response), transcript, window);
  } catch (error) {
    if (!(error instanceof SyntaxError) || window.text.length < 2 * SMALLEST_WINDOW) throw error;
    const [first, second] = halves(transcript, window);
    await takeTurn(env, message);
    const left = await figuresIn(env, message, transcript, first);
    await takeTurn(env, message);
    const both = [...left, ...(await figuresIn(env, message, transcript, second))];
    // Each figure's page is found again in the whole window: a value each half saw once may be
    // printed in both, and then it has no page, as it would have had read whole.
    return reportsInWindow(JSON.stringify({ products: both }), transcript, window);
  }
}

/** Put a document's windows together into its reading once every one is in. */
async function gatherWindows(message: VisionWindow, env: Env): Promise<void> {
  const listed = await env.ARCHIVE.list({
    prefix: partKey.windows(message.sha256, READER),
    limit: 1000,
  });
  const windows = (
    await Promise.all(
      listed.objects.map(async (object) => (await env.ARCHIVE.get(object.key))?.json<ReadWindow>()),
    )
  ).filter(
    (window): window is ReadWindow => window !== undefined && window.window <= message.windows,
  );
  if (windows.length < message.windows) return;
  const object = await env.ARCHIVE.get(partKey.markdown(message.sha256, TRANSCRIBER));
  if (!object) throw new Error(`the transcript of ${message.sha256} is not in the archive`);
  await writeReading(message, env, await object.text(), windows);
}

/** The document's reading: every window's figures merged, with what could not be read counted. */
async function writeReading(
  message: VisionDocument | VisionPage | VisionWindow,
  env: Env,
  transcript: string,
  windows: ReadWindow[],
): Promise<void> {
  const reading = {
    sha256: message.sha256,
    url: message.url,
    products: mergeReports(windows.flatMap((w) => w.products)),
    pages: transcriptPages(transcript),
    // Pages that could not be written down, and windows that could not be read.
    failed: notTranscribed(transcript).length + windows.filter((w) => w.failed).length,
    windows: windows.length,
    transcript: partKey.markdown(message.sha256, TRANSCRIBER),
    extractedBy: VISION_EXTRACTOR_ID,
  };
  await env.ARCHIVE.put(
    partKey.reading(message.sha256, READER),
    `${JSON.stringify(reading)}\n`,
    AS_JSON,
  );
}

/** How many pages a transcript holds, by its page headings. */
function transcriptPages(transcript: string): number {
  return (transcript.match(/^### Page \d+$/gm) ?? []).length;
}

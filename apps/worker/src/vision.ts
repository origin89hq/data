import { contentOf } from "./classify.ts";
import {
  CONVERTER,
  hasTextLayer,
  MAX_PAGES,
  MAX_RENDER_BYTES,
  mergeReports,
  PAGE_CONVERTER,
  PAGE_FIGURES_SYSTEM,
  type Reported,
  reportsOnPage,
  TRANSCRIBE_SYSTEM,
  TRANSCRIPT_SCHEMA,
  textLayer,
  transcriptDocument,
  transcriptOf,
  VISION_EXTRACTOR_ID,
  VISION_MODEL,
  VISION_RESPONSE_SCHEMA,
} from "./reading.ts";
import { type Pdfium, png, pngDataUrl, renderPage } from "./render.ts";
import { LAST_ATTEMPT, partKey, readerKey, sendAll, type Work } from "./work.ts";

/**
 * The page reader's two steps: decide whether a document needs its pages looked at, then look at
 * one page. Kept out of the queue handler, which passes PDFium in, so both can be run in a test
 * against the same PDFium binary the Worker uses.
 */

type VisionDocument = Extract<Work, { kind: "vision" }>;
type VisionPage = Extract<Work, { kind: "vision-page" }>;

/** What one page gave: what it says, the figures read from that, or why it gave neither. */
export interface SeenPage {
  page: number;
  /** The page written down; empty when it could not be drawn or transcribed. */
  markdown: string;
  products: Reported[];
  failed?: string;
}

const READER = readerKey(VISION_EXTRACTOR_ID);
const AS_JSON = { httpMetadata: { contentType: "application/json" } };
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The model, or the page reader's own pace, said not yet. The page goes back on the queue to wait
 * its turn, and the refusal is not written down as the page's answer. Retried at once, all four
 * deliveries of a page fell inside one minute of Kimi's limit, and 1,996 of 2,148 pages were kept
 * as failed (#29).
 */
class NotYet extends Error {}

/** Workers AI's answer when an account is over a model's requests per minute. */
const rateLimited = (error: unknown): boolean => /\b3021\b/.test(reason(error));

/**
 * Times a page is put back before a refusal counts as a failure like any other. Thirty waits, most
 * of them at the half-hour cap, is about half a day: longer than the whole backlog of scans takes
 * at the page reader's pace, and still an end for a page the model never serves.
 */
export const MAX_WAITS = 30;

/**
 * How long a page waits before it is tried again: a minute, doubling to half an hour, and up to a
 * minute more by page, so a document's pages turned away together do not all come back together.
 */
export function waitFor(message: VisionPage): number {
  const waits = message.waits ?? 0;
  const spread = (Number.parseInt(message.sha256.slice(0, 4), 16) + message.page) % 60;
  return Math.min(60 * 2 ** waits, 1800) + spread;
}

/** A model's answer as it came, before anything is taken out of it. */
function answerText(response: unknown): string {
  const r = response as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  const content = typeof r?.response === "string" ? r.response : r?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("model returned no text");
  return content;
}

/** Whether a converted document needs its pages looked at, and if it does, one message per page. */
export async function seeDocument(message: VisionDocument, env: Env): Promise<void> {
  const reading = partKey.reading(message.sha256, READER);
  if (await env.ARCHIVE.head(reading)) return;
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

/** One page: drawn, written down and read once, then put together with the others if it was the last to land. */
export async function seePage(
  message: VisionPage,
  env: Env,
  attempt: number,
  library: () => Promise<Pdfium>,
): Promise<void> {
  if (await env.ARCHIVE.head(partKey.reading(message.sha256, READER))) return;
  const key = partKey.page(message.sha256, READER, message.page);
  if (!(await env.ARCHIVE.head(key))) {
    let seen: SeenPage;
    try {
      seen = await readPage(message, env, attempt, library);
    } catch (error) {
      if (!(error instanceof NotYet)) throw error;
      // A new message rather than a retry, so waiting its turn does not use up the deliveries a
      // page gets for failures of its own.
      await env.WORK.send(
        { ...message, waits: (message.waits ?? 0) + 1 },
        { delaySeconds: waitFor(message) },
      );
      return;
    }
    await env.ARCHIVE.put(key, `${JSON.stringify(seen)}\n`, AS_JSON);
  }
  await gatherPages(message, env);
}

/** Draw one page, write down what it says, and read the figures out of what was written. */
async function readPage(
  message: VisionPage,
  env: Env,
  attempt: number,
  library: () => Promise<Pdfium>,
): Promise<SeenPage> {
  const { page } = message;
  // Past its last wait a page is not held back any more: whatever the model says next is its answer.
  const mayWait = (message.waits ?? 0) < MAX_WAITS;
  // Asked before anything is drawn, so a page turned away costs one check and nothing else.
  if (mayWait && !(await env.PAGE_READER_PACE.limit({ key: VISION_MODEL })).success)
    throw new NotYet("over the page reader's pace");
  const source = await env.ARCHIVE.get(`archive/${message.sha256}`);
  if (!source) throw new Error(`archive/${message.sha256} is not in the archive`);
  const pdfium = await library();
  let image: string;
  try {
    const drawn = renderPage(pdfium, new Uint8Array(await source.arrayBuffer()), page);
    image = pngDataUrl(await png(drawn.width, drawn.height, drawn.rgb));
  } catch (error) {
    // A page PDFium cannot draw will not draw on the next attempt either.
    return { page, markdown: "", products: [], failed: `not drawn: ${reason(error)}` };
  }
  // Kimi's own name for the switch: `enable_thinking`, which other models take, it ignores.
  const quietly = { temperature: 0, chat_template_kwargs: { thinking: false } };
  let markdown: string;
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
      ...quietly,
    } as never);
    markdown = transcriptOf(answerText(response));
  } catch (error) {
    if (mayWait && rateLimited(error)) throw new NotYet(reason(error));
    // A model call fails for reasons that pass, so the queue tries it again. On the last attempt the
    // failure is written down instead: one page that never lands would hold the reading back for ever.
    if (attempt < LAST_ATTEMPT) throw error;
    return { page, markdown: "", products: [], failed: `not transcribed: ${reason(error)}` };
  }
  // A page with no digit on it prints no rating, and asking would cost a call: a drawing, a logo.
  if (!/\d/.test(markdown)) return { page, markdown, products: [] };
  try {
    const response = await env.AI.run(VISION_MODEL, {
      messages: [
        { role: "system", content: PAGE_FIGURES_SYSTEM },
        { role: "user", content: markdown },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "figures", schema: VISION_RESPONSE_SCHEMA, strict: false },
      },
      max_tokens: 4096,
      ...quietly,
    } as never);
    return { page, markdown, products: reportsOnPage(contentOf(response), page) };
  } catch (error) {
    // The page waits and is written down again when its turn comes: one more call, and a page
    // with both steps from one delivery.
    if (mayWait && rateLimited(error)) throw new NotYet(reason(error));
    if (attempt < LAST_ATTEMPT) throw error;
    // The transcription stands whatever happened to the read of it: it is the part worth keeping.
    return { page, markdown, products: [], failed: `not read: ${reason(error)}` };
  }
}

/**
 * Put a document's pages together once every one is in: its transcription, as a conversion beside
 * `toMarkdown`'s, and its reading. Whichever page lands last does it; two landing at once both do,
 * and write the same bytes, because the pages are put together in page order.
 */
async function gatherPages(message: VisionPage, env: Env): Promise<void> {
  const listed = await env.ARCHIVE.list({
    prefix: partKey.pages(message.sha256, READER),
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
  // The transcription first: it is the record, and the reading is one thing read out of it.
  const transcript = partKey.markdown(message.sha256, PAGE_CONVERTER);
  const name = new URL(message.url).pathname.split("/").pop() || message.sha256;
  await env.ARCHIVE.put(transcript, transcriptDocument(name, pages), {
    httpMetadata: { contentType: "text/markdown" },
  });
  const reading = {
    sha256: message.sha256,
    url: message.url,
    products: mergeReports(pages.flatMap((p) => p.products)),
    pages: pages.length,
    failed: pages.filter((p) => p.failed).length,
    transcript,
    extractedBy: VISION_EXTRACTOR_ID,
  };
  await env.ARCHIVE.put(
    partKey.reading(message.sha256, READER),
    `${JSON.stringify(reading)}\n`,
    AS_JSON,
  );
}

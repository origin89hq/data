import { contentOf } from "./classify.ts";
import {
  chunk,
  EXTRACT_MODEL,
  EXTRACTOR_ID,
  mergeReports,
  RESPONSE_SCHEMA,
  type Reported,
  SYSTEM,
} from "./reading.ts";
import { LAST_ATTEMPT, partKey, readerKey, type Work } from "./work.ts";

/**
 * The text reader: a converted document read for figures a window at a time. Kept out of the queue
 * handler, which loads PDFium, so it can be run in a test.
 */

type ExtractMessage = Extract<Work, { kind: "extract" }>;

/** What one window of a document gave: the figures read out of it, or why there are none. */
export interface ReadWindow {
  window: number;
  products: Reported[];
  failed?: string;
}

const READER = readerKey(EXTRACTOR_ID);
const AS_JSON = { httpMetadata: { contentType: "application/json" } };
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Windows a message reads when it does not say, so one long manual cannot spend a run's budget. */
export const MAX_WINDOWS = 60;

/**
 * Read a converted document for the figures it states, and write the reading once every window is
 * in. Each window's answer is kept beside the document as it lands, so a later delivery reads only
 * the windows still missing. A window whose call fails is left for the queue to deliver again, and
 * is written down as failed only on the last attempt. Caught and counted on the first, a rate
 * limit, a timeout and an answer cut short were all kept out of the reading for good (#41).
 */
export async function readDocument(
  message: ExtractMessage,
  env: Env,
  attempt: number,
): Promise<void> {
  const reading = partKey.reading(message.sha256, READER);
  // Reading a document is the expensive step, and both the document and the reading are
  // addressed by content, so a reading that exists is a reading of exactly these bytes by
  // exactly this reader — whichever run asked for it.
  if (await env.ARCHIVE.head(reading)) return;
  const object = await env.ARCHIVE.get(message.key);
  if (!object) throw new Error(`${message.key} is gone`);
  const windows = chunk(await object.text()).slice(0, message.maxWindows ?? MAX_WINDOWS);
  const kept = await keptWindows(env, message.sha256, windows.length);
  const read: ReadWindow[] = [];
  const unread: string[] = [];
  for (const [i, window] of windows.entries()) {
    const number = i + 1;
    const done = kept.get(number);
    if (done) {
      read.push(done);
      continue;
    }
    let answer: ReadWindow;
    try {
      answer = { window: number, products: await readWindow(env, window) };
    } catch (error) {
      // The rest of the windows are still read, so one delivery again covers every window missed.
      if (attempt < LAST_ATTEMPT) {
        unread.push(`window ${number}: ${reason(error)}`);
        continue;
      }
      answer = { window: number, products: [], failed: `not read: ${reason(error)}` };
    }
    await env.ARCHIVE.put(
      partKey.window(message.sha256, READER, number),
      `${JSON.stringify(answer)}\n`,
      AS_JSON,
    );
    read.push(answer);
  }
  if (unread.length > 0)
    throw new Error(`${unread.length} of ${windows.length} windows not read; ${unread[0]}`);
  // Compact, one object per line. Pretty-printing meant a run read back as a concatenation
  // of multi-line objects, which is not the newline-delimited stream every reader expects.
  await env.ARCHIVE.put(
    reading,
    `${JSON.stringify({
      sha256: message.sha256,
      url: message.url,
      products: mergeReports(read.flatMap((w) => w.products)),
      windows: windows.length,
      failed: read.filter((w) => w.failed).length,
    })}\n`,
    AS_JSON,
  );
}

/**
 * The windows of a document already read, by number, up to the ones this reading has. Every page
 * of the listing: a window missed here would be read again, and paid for again.
 */
async function keptWindows(
  env: Env,
  sha256: string,
  windows: number,
): Promise<Map<number, ReadWindow>> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({
      prefix: partKey.windows(sha256, READER),
      limit: 1000,
      cursor,
    });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const kept = await Promise.all(
    keys.map(async (key) => (await env.ARCHIVE.get(key))?.json<ReadWindow>()),
  );
  return new Map(
    kept
      .filter((w): w is ReadWindow => w !== undefined && w.window <= windows)
      .map((w) => [w.window, w]),
  );
}

/** One model call for one window, with each figure given the page the window starts on. */
async function readWindow(env: Env, window: { text: string; page?: number }): Promise<Reported[]> {
  const response = await env.AI.run(EXTRACT_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: window.text },
    ],
    response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    max_tokens: 3072,
  } as never);
  const parsed = JSON.parse(contentOf(response)) as { products?: Reported[] };
  if (!Array.isArray(parsed.products)) return [];
  // The page comes from where the window started, not from the model: an invented page number is
  // worse than none, because it looks checkable.
  return parsed.products
    .filter((product) => Array.isArray(product?.specs))
    .map((product) => ({
      ...product,
      specs: product.specs.map((s) => ({
        ...s,
        ...(window.page === undefined ? {} : { page: window.page }),
      })),
    }));
}

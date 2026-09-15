import { contentOf } from "./classify.ts";
import { makerName } from "./manufacturers.ts";
import {
  asciiSymbols,
  chunk,
  EXTRACT_MODEL,
  EXTRACTOR_ID,
  mergeReports,
  pageOfFigure,
  printedSymbols,
  RESPONSE_SCHEMA,
  type Reported,
  SYSTEM,
  type Window,
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
      answer = {
        window: number,
        products: await readWindow(env, window, makerName(message.manufacturer)),
      };
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

/**
 * One model call for one window, with each figure given the page its value is printed on. The
 * message starts with the maker's name, so the model can leave out another company's products and
 * the settings a maker prints for them (#144). The window's "≥", "≤" and "～" are spelled in ASCII,
 * which the model copies where it garbled the symbols, and its answer is given "≥" and "≤" back
 * where the window prints them (#145).
 */
async function readWindow(env: Env, window: Window, maker: string): Promise<Reported[]> {
  const shown: Window = { ...window, text: asciiSymbols(window.text) };
  const response = await env.AI.run(EXTRACT_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Maker: ${maker}\n\n${shown.text}` },
    ],
    response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    max_tokens: 3072,
  } as never);
  const parsed = JSON.parse(contentOf(response)) as { products?: Reported[] };
  if (!Array.isArray(parsed.products)) return [];
  // The page comes from where the value is printed in the window, not from the model: an invented
  // page number is worse than none, because it looks checkable. The model's is dropped even where
  // no page is found, which a window with no page markers used to keep.
  return parsed.products
    .filter((product) => Array.isArray(product?.specs))
    .map((product) => ({
      ...product,
      // A null or a bare string among a product's figures is dropped rather than failing the window;
      // a name or value that is not a string is left for the merge to refuse.
      specs: product.specs
        .filter((s) => typeof s === "object" && s !== null)
        .map(({ page: _claimed, ...read }) => {
          // The page is looked up in the window as the model was shown it, so a value it copied
          // with "~" or with an operator the sheet prints in ASCII is still found.
          const page =
            typeof read.name === "string" && typeof read.value === "string"
              ? pageOfFigure(shown, {
                  name: asciiSymbols(read.name),
                  value: asciiSymbols(read.value),
                })
              : window.page;
          return {
            ...read,
            ...(typeof read.name === "string"
              ? { name: printedSymbols(window.text, read.name) }
              : {}),
            ...(typeof read.value === "string"
              ? { value: printedSymbols(window.text, read.value) }
              : {}),
            ...(typeof read.conditions === "string"
              ? { conditions: printedSymbols(window.text, read.conditions) }
              : {}),
            ...(page === undefined ? {} : { page }),
          };
        }),
    }));
}

import { answerText } from "./classify.ts";
import { pagesUnconverted } from "./convert.ts";
import { type DocumentKind, keptKind, leftUnread, sortDocument } from "./gate.ts";
import type { Section } from "./layout.ts";
import { makerName } from "./manufacturers.ts";
import { NotYet, rateLimited, takeTurn, waitTurn } from "./pace.ts";
import {
  answerObjects,
  asciiSymbols,
  CONVERTER,
  chunk,
  EXTRACT_MODEL,
  EXTRACTOR_ID,
  mergeReports,
  pageOfFigure,
  printedSymbols,
  printsValue,
  type Reported,
  SYSTEM,
  TEXT_RESPONSE_SCHEMA,
  type Window,
} from "./reading.ts";
import { LAST_ATTEMPT, MOST_WINDOWS, partKey, readerKey, type Work } from "./work.ts";

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

/** As much of a reading already written as says how far it got. */
interface KeptReading {
  windows: number;
  unread?: number;
  skipped?: DocumentKind;
}

const READER = readerKey(EXTRACTOR_ID);
const AS_JSON = { httpMetadata: { contentType: "application/json" } };
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Windows a message reads when it does not say, so one long manual cannot spend a run's budget.
 *
 * As many as one message may ask for. It was sixty, which a manual fitted when it came from
 * `toMarkdown`. Read from its pages, a manual of ruled tables runs longer: Magnum's MS-PAE manual
 * went from 35 windows to 119 and prints its specifications in window 105, so sixty read the
 * installation chapters and stopped before a single rating. A manual keeps its specifications at
 * the back, which is the part a cap cuts: 49 of wave 2's documents had fitted under sixty before
 * and did not after.
 */
export const MAX_WINDOWS = MOST_WINDOWS;

/**
 * Room for one window's answer. A dense table of several models runs past two thousand tokens, and
 * an answer cut short is a window read again.
 */
const ANSWER_TOKENS = 8192;

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
  const reading = partKey.reading(message.sha256, message.manufacturer, READER);
  const cap = message.maxWindows ?? MAX_WINDOWS;
  // Reading a document is the expensive step, and both the document and the reading are
  // addressed by content, so a reading that exists is a reading of exactly these bytes by
  // exactly this reader for this maker — whichever of its runs asked for it.
  //
  // It is finished unless it stopped at a lower cap than this one, or its text has grown since: a
  // PDF converted again has the pages its first conversion left out. Then it is read on from where
  // it stopped: its windows are kept beside it and are not read again, so only what is new is paid
  // for. A document the gate left unread is finished whatever the cap.
  const written = await env.ARCHIVE.get(reading);
  const before = written ? await written.json<KeptReading>() : undefined;
  if (before && (before.skipped !== undefined || before.windows >= cap)) return;
  const object = await env.ARCHIVE.get(message.key);
  if (!object) {
    if (before) return;
    throw new Error(`${message.key} is gone`);
  }
  const markdown = await object.text();
  const all = chunk(markdown);
  if (before && before.windows >= all.length) return;
  // Pages the converter did not write down, which no window can have read.
  const unconverted = pagesUnconverted(object.customMetadata);
  // The document is sorted by kind before any window is read, with a turn of its own. A kind that
  // states no ratings of the maker's products is written down as read with nothing in it, so the
  // run counts it read and the pull clears figures it gave before. A document the gate cannot sort
  // by its last delivery is read, since leaving it unread would lose its ratings for good.
  let sorted: DocumentKind | undefined = await keptKind(env, message.sha256, message.manufacturer);
  if (!sorted) {
    try {
      const mayWait = await takeTurn(env, message, EXTRACT_MODEL);
      try {
        sorted = await sortDocument(env, message, makerName(message.manufacturer), markdown);
      } catch (error) {
        if (mayWait && rateLimited(error)) throw new NotYet(reason(error));
        throw error;
      }
    } catch (error) {
      if (error instanceof NotYet) {
        await waitTurn(env, message, error);
        return;
      }
      if (attempt < LAST_ATTEMPT) throw error;
    }
  }
  if (sorted && leftUnread(sorted)) {
    await env.ARCHIVE.put(
      reading,
      `${JSON.stringify({ sha256: message.sha256, url: message.url, products: [], windows: 0, failed: 0, skipped: sorted })}\n`,
      AS_JSON,
    );
    return;
  }
  const windows = all.slice(0, cap);
  // What the document calls the part of itself each window comes from. The section is what tells a
  // recommended wire size from a rated current, and the converter wrote it down beside the document.
  // One converted before there were outlines has none, and is read as it was.
  const sections = await documentSections(env, message.sha256);
  const kept = await keptWindows(env, message, windows.length);
  // A reading of the whole of a shorter text ended on that text's last window, cut off where the
  // text ended. In the longer text the same window runs to its full length, and what it now holds
  // past the old end can lie before the next window starts, read by neither: so it is read again.
  // A reading stopped by the cap ended on a full window, and has no such gap.
  if (before && before.unread === undefined) kept.delete(before.windows);
  const read: ReadWindow[] = [];
  const unread: string[] = [];
  let turnedAway: NotYet | undefined;
  // Windows this delivery read itself, so a document turned away after reading knows it had a turn.
  let readNow = 0;
  for (const [i, window] of windows.entries()) {
    const number = i + 1;
    const done = kept.get(number);
    if (done) {
      read.push(done);
      continue;
    }
    let answer: ReadWindow;
    try {
      // A turn with Kimi for each window, from the budget the page reader shares.
      const mayWait = await takeTurn(env, message, EXTRACT_MODEL);
      try {
        answer = {
          window: number,
          products: await readWindow(
            env,
            window,
            makerName(message.manufacturer),
            sectionOver(sections, window.page),
          ),
        };
      } catch (error) {
        if (mayWait && rateLimited(error)) throw new NotYet(reason(error));
        throw error;
      }
    } catch (error) {
      if (error instanceof NotYet) {
        turnedAway = error;
        break;
      }
      // The rest of the windows are still read, so one delivery again covers every window missed.
      if (attempt < LAST_ATTEMPT) {
        unread.push(`window ${number}: ${reason(error)}`);
        continue;
      }
      answer = { window: number, products: [], failed: `not read: ${reason(error)}` };
    }
    await env.ARCHIVE.put(
      partKey.window(message.sha256, message.manufacturer, READER, number),
      `${JSON.stringify(answer)}\n`,
      AS_JSON,
    );
    read.push(answer);
    readNow += 1;
  }
  // Turned away: the windows read are kept, and the document goes back on the queue to read the
  // rest when its turn comes, without using up a delivery of its own.
  if (turnedAway) {
    await waitTurn(env, message, turnedAway, readNow > 0);
    return;
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
      // A document longer than the cap is read as far as the cap, and the reading says how much it
      // left. Without this a reading that stopped looked like one of the whole document, and a
      // manual's specifications went missing with nothing anywhere to say they had been skipped.
      ...(all.length > windows.length ? { unread: all.length - windows.length } : {}),
      // And the pages the converter never wrote down, for a document longer than it writes.
      ...(unconverted > 0 ? { unconverted } : {}),
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
  { sha256, manufacturer }: ExtractMessage,
  windows: number,
): Promise<Map<number, ReadWindow>> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({
      prefix: partKey.windows(sha256, manufacturer, READER),
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

/** The sections the converter found, or none for a document converted before it wrote them down. */
async function documentSections(env: Env, sha256: string): Promise<Section[]> {
  const kept = await env.ARCHIVE.get(partKey.outline(sha256, CONVERTER));
  if (!kept) return [];
  const read = await kept.json().catch(() => undefined);
  return Array.isArray(read) ? (read as Section[]) : [];
}

/** The innermost section a page falls in: the last one that begins at or before it. */
function sectionOver(sections: readonly Section[], page: number | undefined): string | undefined {
  if (!page) return undefined;
  const holding = sections.filter((s) => s.title && s.from <= page && page <= s.to);
  return holding.at(-1)?.title;
}

/** A product and its figures as the model labels them, before only ratings of products are kept. */
type Labelled = {
  model: string;
  is?: unknown;
  specs: (Reported["specs"][number] & { is?: unknown })[];
};

/**
 * One model call for one window, with each figure given the page its value is printed on. The
 * message starts with the maker's name, so the model can leave out another company's products and
 * the settings a maker prints for them (#144). The window's "≥", "≤" and "～" are spelled in ASCII,
 * which the model copies where it garbled the symbols, and its answer is given "≥" and "≤" back
 * where the window prints them (#145).
 */
async function readWindow(
  env: Env,
  window: Window,
  maker: string,
  section?: string,
): Promise<Reported[]> {
  const shown: Window = { ...window, text: asciiSymbols(window.text) };
  const response = await env.AI.run(EXTRACT_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Maker: ${maker}\n${section ? `Section: ${section}\n` : ""}\n${shown.text}`,
      },
    ],
    // Held to the schema and told not to think, as the page reader's calls to the same model are:
    // without both, Kimi writes its thinking into the answer. (Llama 3.3, the reader before it,
    // answered `{"products":[]}` for whole windows when held to a schema, and was held to none.) The
    // prompt still gives the answer's shape, and an answer that is not JSON fails the window like
    // one cut short.
    response_format: {
      type: "json_schema",
      json_schema: { name: "figures", schema: TEXT_RESPONSE_SCHEMA, strict: false },
    },
    chat_template_kwargs: { thinking: false },
    max_tokens: ANSWER_TOKENS,
  } as never);
  // Every object in the answer counts, fenced or not: a note after it, or an empty answer before the
  // real one, no longer fails the window or hides the figures.
  const products = answerObjects(answerText(response)).flatMap((answer) => {
    const listed = (answer as { products?: unknown } | null)?.products;
    return Array.isArray(listed) ? (listed as Labelled[]) : [];
  });
  // The page comes from where the value is printed in the window, not from the model: an invented
  // page number is worse than none, because it looks checkable. The model's is dropped even where
  // no page is found, which a window with no page markers used to keep.
  return (
    products
      .filter((product) => Array.isArray(product?.specs))
      // Only a product of the maker's own is filed: the model labels a family, a kit and another
      // company's product for what they are. A product it gave no label is kept rather than lost.
      .filter((product) => product.is === undefined || product.is === "product")
      .map(({ is: _product, ...product }) => ({
        ...product,
        // A null or a bare string among a product's figures is dropped rather than failing the window;
        // a name or value that is not a string is left for the merge to refuse.
        specs: product.specs
          .filter((s) => typeof s === "object" && s !== null)
          // And only its ratings: a setting, an instruction, a test and an example are labelled too.
          .filter((s) => s.is === undefined || s.is === "rating")
          // A value the window does not print was not read from it: the comparison that chose this
          // reader found every such figure wrong, and no right one among them.
          .filter(
            (s) => typeof s.value !== "string" || printsValue(shown.text, asciiSymbols(s.value)),
          )
          .map(({ page: _claimed, is: _figure, ...read }) => {
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
      }))
  );
}

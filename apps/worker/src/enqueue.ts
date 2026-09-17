import { withoutTranslations } from "@origin89/equipment-schema/documents";
import { Sighting } from "@origin89/equipment-schema/sighting";
import { classifierKey } from "./classify.ts";
import { clearPrefix } from "./feeds.ts";
import { CONVERTER, EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "./reading.ts";
import { pointerKey, readPointer, runPrefix } from "./runs.ts";
import { batches, partKey, readerKey, sendAll, type Work } from "./work.ts";

/** Listings per model call. Ten, because answers are matched to listings by position and a long list is where a model starts skipping one. */
export const CLASSIFY_BATCH = 10;

/**
 * Pages of a crawl read at once. Read one at a time, a shop of 147 pages took forty seconds, and
 * the four largest shops took over two minutes of a pass that outlasted the workflow waiting on
 * it. Six, because a Worker holds six connections open at once and further reads would only queue.
 */
export const PAGES_AT_ONCE = 6;

/**
 * Fill the queue from a finished crawl, then write the manifest that says how many parts to expect.
 * A reader that finds the manifest knows what a complete run looks like, and a gap in the parts
 * is visible as a gap rather than as a shorter answer. It is written last: written first, a send
 * that failed partway left a manifest promising parts nobody sent, and the run counted as
 * classified, so no pass sent them. Without one, the next pass classifies the run again.
 *
 * Every listing goes, answered before or not. The consumer reuses an answer it already has and
 * asks a model only for the rest, so a shop that did not change still costs no model call, and
 * each run's parts hold a guess for every listing it sells, which is what the gate reads (#16).
 */
export async function classifyRun(
  env: Env,
  seller: string,
  date: string,
): Promise<{ parts: number; sightings: number }> {
  // Whichever run is current for this seller, not whichever shares today's date.
  const pointer = await readPointer(env.ARCHIVE, pointerKey.sightings(seller));
  if (!pointer) throw new Error(`${seller}: no current run`);
  const prefix = runPrefix.sightings(seller, pointer.run);
  const manifest = await env.ARCHIVE.get(`${prefix}/manifest.json`);
  if (!manifest) throw new Error(`${prefix}: no manifest, the crawl did not finish`);
  const pages = (await manifest.json<{ pages: { page: number }[] }>()).pages.map((p) => p.page);

  const sightings: Sighting[] = [];
  for (let i = 0; i < pages.length; i += PAGES_AT_ONCE) {
    const texts = await Promise.all(
      pages.slice(i, i + PAGES_AT_ONCE).map(async (page) => {
        const object = await env.ARCHIVE.get(
          `${prefix}/page-${String(page).padStart(4, "0")}.jsonl`,
        );
        if (!object) throw new Error(`page ${page} of ${seller} is missing`);
        return object.text();
      }),
    );
    // In page order whichever read finished first, so a run's parts hold the same listings each time.
    for (const text of texts)
      for (const line of text.split("\n").filter(Boolean))
        sightings.push(Sighting.parse(JSON.parse(line)));
  }

  // Classifying a run again replaces what the last classification wrote. An old part left in place
  // counted toward the new manifest before the new part landed, and stood in for one that never
  // did. The manifest goes first, so the run reads as unclassified until every part is sent again.
  const guesses = runPrefix.guesses(seller, pointer.run, classifierKey());
  await env.ARCHIVE.delete(`${guesses}/manifest.json`);
  await clearPrefix(env.ARCHIVE, `${guesses}/`);

  const parts = batches(sightings, CLASSIFY_BATCH);
  await sendAll(
    env.WORK,
    parts.map(
      (batch, i): Work => ({
        kind: "classify",
        seller,
        date,
        run: pointer.run,
        part: i + 1,
        sightings: batch,
      }),
    ),
  );
  await env.ARCHIVE.put(
    `${guesses}/manifest.json`,
    JSON.stringify(
      {
        seller,
        checkedAt: date,
        by: classifierKey(),
        parts: parts.length,
        sightings: sightings.length,
        pages: parts.map((p, i) => ({ page: i + 1, count: p.length })),
      },
      null,
      2,
    ),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  return { parts: parts.length, sightings: sightings.length };
}

/**
 * Fill the queue with the maker's own specification pages. These are read by a parser rather than
 * a model, so nothing is approved and nothing is spent: a page a maker publishes for people to
 * read is a page that can be read.
 */
export async function specPagesRun(
  env: Env,
  manufacturer: string,
  date: string,
  pages: { manufacturer: string; url: string }[],
): Promise<{ pages: number }> {
  const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
  if (!pointer) throw new Error(`${manufacturer}: no current run`);
  const mine = pages.filter((p) => p.manufacturer === manufacturer);
  await sendAll(
    env.WORK,
    mine.map(
      (p): Work => ({ kind: "spec-table", manufacturer, date, run: pointer.run, url: p.url }),
    ),
  );
  return { pages: mine.length };
}

/**
 * Fill the queue from the documents a person approved. Each converted document enqueues its own
 * reading, so one call runs both halves without anything supervising from above.
 */
interface ApprovedDocument {
  url: string;
  sha256: string;
  contentType: string;
}

/**
 * A maker's current run and the documents conversion will take from it: one per distinct
 * content, and a translation dropped where the maker also publishes an edition not marked as one.
 * Forgetting works from the same list, so a reading it removes is one the next convert asks for.
 */
async function approvedDocuments(
  env: Env,
  manufacturer: string,
): Promise<{
  run: string;
  prefix: string;
  documents: ApprovedDocument[];
  translations: { url: string; language: string }[];
}> {
  const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
  if (!pointer) throw new NothingApproved(`${manufacturer}: no current run`);
  const prefix = runPrefix.documents(manufacturer, pointer.run);
  const manifest = await env.ARCHIVE.get(`${prefix}/manifest.json`);
  if (!manifest) throw new NothingApproved(`${prefix}: nothing approved to convert`);
  const { documents } = await manifest.json<{ documents: ApprovedDocument[] }>();
  // Two shops can link the same PDF; the archive keys by content, so one document is one message.
  const deduplicated = [...new Map(documents.map((d) => [d.sha256, d])).values()];
  // A maker's Spanish edition of a manual it also publishes in English states the same figures in
  // another language. Converting it costs a reading and a model call for figures already held, so
  // it is dropped here rather than after the money is spent.
  const { keep, dropped } = withoutTranslations(deduplicated);
  return { run: pointer.run, prefix, documents: keep, translations: dropped };
}

/** The readers whose answers depend on a prompt: the text reader and the page reader. The table reader is a parser. */
const PROMPTED_READERS = () => [readerKey(EXTRACTOR_ID), readerKey(VISION_EXTRACTOR_ID)];

/** Documents forgotten in one call. Each costs a list and, when removing, a delete; a Worker gets a thousand such calls. */
export const FORGET_AT_ONCE = 200;

/**
 * Forget what the prompted readers said about a maker's approved documents, so the next
 * `convert` reads them again with the prompts as they are now.
 *
 * A reading is addressed by the document's bytes, the maker and the reader, and a document read
 * once is never read again; that is what keeps a second run from paying twice, and it is also what
 * keeps a changed prompt from reaching a document already read (#127). Forgetting removes the
 * reading and the windows kept beside it for each prompted reader, for this maker only; another
 * maker that publishes the same document keeps its own. Nothing else goes: the converted
 * markdown, the transcribed pages and the table reader's parse cost nothing to keep and are not
 * what changed. The page reader's offer marker goes with them, or the run would count as offered
 * already and never send the scanned documents again. A dry run counts what would go and removes
 * nothing. The documents are taken `FORGET_AT_ONCE` at a time from `from`, and `next` says where
 * the next call starts, so a maker of four hundred documents stays inside a Worker's budget.
 */
/** The run a later batch names is not the maker's current run: the pointer moved between two calls. */
export class RunMoved extends Error {}
/** A batch's start is not one a previous batch answered with. */
export class BadStart extends Error {}
/** The maker has no current run, or its run has nothing approved: nothing to forget. */
export class NothingApproved extends Error {}

export async function forgetReadings(
  env: Env,
  manufacturer: string,
  dryRun: boolean,
  from = 0,
  expectedRun?: string,
): Promise<{
  run: string;
  documents: number;
  from: number;
  next?: number;
  readings: number;
  windows: number;
  deleted: boolean;
}> {
  // Every batch counts from one manifest: a later one names the run the first answered with, and
  // the pointer is compared before the new run's manifest is asked for, since a run that has just
  // been reserved has none yet.
  if (expectedRun !== undefined) {
    const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
    if (pointer && pointer.run !== expectedRun)
      throw new RunMoved(
        `${manufacturer}: run ${expectedRun} is no longer current; ${pointer.run} is`,
      );
  }
  const { run, prefix, documents } = await approvedDocuments(env, manufacturer);
  // A batch starts where the last one said the next begins, and the run remembers what it said:
  // a start with no batch before it would count the maker done with readings still on file.
  const marker = `${prefix}/forgetting.json`;
  if (from !== 0) {
    const issued = await (await env.ARCHIVE.get(marker))?.json<{ next?: number; dry?: boolean }>();
    if (issued?.next !== from || issued.dry !== dryRun)
      throw new BadStart(`${manufacturer}: from must be the next the last batch answered with`);
  }
  const readers = PROMPTED_READERS();
  const batch = documents.slice(from, from + FORGET_AT_ONCE);
  let readings = 0;
  let windows = 0;
  for (const { sha256 } of batch) {
    // One list per document covers both readers' reading and windows for this maker: the keys
    // share its prefix.
    const keys: string[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await env.ARCHIVE.list({
        prefix: `archive/${sha256}.${manufacturer}.`,
        limit: 1000,
        cursor,
      });
      keys.push(...page.objects.map((o) => o.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    const gone = keys.filter((key) =>
      readers.some(
        (reader) =>
          key === partKey.reading(sha256, manufacturer, reader) ||
          key.startsWith(partKey.windows(sha256, manufacturer, reader)),
      ),
    );
    readings += gone.filter((key) => key.endsWith(".reading.json")).length;
    windows += gone.length - gone.filter((key) => key.endsWith(".reading.json")).length;
    if (!dryRun && gone.length > 0) await env.ARCHIVE.delete(gone);
  }
  const next = from + batch.length < documents.length ? from + batch.length : undefined;
  // On the last real batch the offer marker goes before the continuation does: if the second
  // delete fails, the continuation still stands and the batch can be sent again, rather than
  // refused for a marker already gone while the stale offer keeps the scanned documents unsent.
  if (!dryRun && next === undefined) await env.ARCHIVE.delete(`${prefix}/seeing.json`);
  if (next === undefined) await env.ARCHIVE.delete(marker);
  else
    await env.ARCHIVE.put(marker, JSON.stringify({ run, next, dry: dryRun }), {
      httpMetadata: { contentType: "application/json" },
    });
  return {
    run,
    documents: documents.length,
    from,
    ...(next === undefined ? {} : { next }),
    readings,
    windows,
    deleted: !dryRun,
  };
}

export async function convertRun(
  env: Env,
  manufacturer: string,
  date: string,
): Promise<{ documents: number; translations: number }> {
  const {
    run,
    prefix,
    documents: unique,
    translations: dropped,
  } = await approvedDocuments(env, manufacturer);
  await env.ARCHIVE.put(
    `${prefix}/converting.json`,
    JSON.stringify(
      {
        manufacturer,
        checkedAt: date,
        converter: CONVERTER,
        extractedBy: EXTRACTOR_ID,
        documents: unique,
      },
      null,
      2,
    ),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  await sendAll(
    env.WORK,
    unique.map(
      (d): Work => ({
        kind: "convert",
        manufacturer,
        date,
        run,
        sha256: d.sha256,
        url: d.url,
        contentType: d.contentType,
      }),
    ),
  );
  return { documents: unique.length, translations: dropped.length };
}

/**
 * Offer a maker's converted documents to the page reader. Each message asks one question — does
 * this document have a text layer? — and only one without goes on to have its pages drawn and
 * read, so offering every document costs a lookup each and the model is paid only for scans.
 *
 * How many were offered is written down once the messages are on the queue. The supervisor offers
 * a run again only when more of it has converted since, which catches up with a conversion still
 * going and offers a finished one once.
 */
export async function visionRun(
  env: Env,
  manufacturer: string,
  date: string,
): Promise<{ documents: number }> {
  const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
  if (!pointer) throw new Error(`${manufacturer}: no current run`);
  const prefix = runPrefix.documents(manufacturer, pointer.run);
  const index = await env.ARCHIVE.get(`${prefix}/converting.json`);
  if (!index) throw new Error(`${prefix}: nothing has been sent to conversion`);
  const { documents } = await index.json<{ documents: { url: string; sha256: string }[] }>();
  const converted = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: `${prefix}/converted/`, cursor, limit: 1000 });
    for (const object of page.objects)
      converted.add(object.key.slice(`${prefix}/converted/`.length).replace(/\.json$/, ""));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Offered already, to this page reader, with nothing converted since: nothing to send. A caller
  // working from an older look at the state, as the workflow's offers do, would otherwise queue
  // every page of the maker again right after a pass had.
  const offered = await (await env.ARCHIVE.get(`${prefix}/seeing.json`))?.json<{
    converted?: number;
    extractedBy?: string;
  }>();
  if (offered?.extractedBy === VISION_EXTRACTOR_ID && (offered.converted ?? 0) >= converted.size)
    return { documents: 0 };
  const ready = documents.filter((d) => converted.has(d.sha256));
  await sendAll(
    env.WORK,
    ready.map(
      (d): Work => ({
        kind: "vision",
        manufacturer,
        date,
        run: pointer.run,
        sha256: d.sha256,
        url: d.url,
      }),
    ),
  );
  await env.ARCHIVE.put(
    `${prefix}/seeing.json`,
    JSON.stringify(
      {
        manufacturer,
        checkedAt: date,
        extractedBy: VISION_EXTRACTOR_ID,
        converted: converted.size,
        documents: ready.length,
      },
      null,
      2,
    ),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  return { documents: ready.length };
}

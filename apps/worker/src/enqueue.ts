import { withoutTranslations } from "@origin89/equipment-schema/documents";
import { Sighting } from "@origin89/equipment-schema/sighting";
import { classifierKey } from "./classify.ts";
import { CONVERTER, EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "./reading.ts";
import { pointerKey, readPointer, runPrefix } from "./runs.ts";
import { batches, sendAll, type Work } from "./work.ts";

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
    `${runPrefix.guesses(seller, pointer.run, classifierKey())}/manifest.json`,
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
export async function convertRun(
  env: Env,
  manufacturer: string,
  date: string,
): Promise<{ documents: number; translations: number }> {
  const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
  if (!pointer) throw new Error(`${manufacturer}: no current run`);
  const prefix = runPrefix.documents(manufacturer, pointer.run);
  const manifest = await env.ARCHIVE.get(`${prefix}/manifest.json`);
  if (!manifest) throw new Error(`${prefix}: nothing approved to convert`);
  const { documents } = await manifest.json<{
    documents: { url: string; sha256: string; contentType: string }[];
  }>();
  // Two shops can link the same PDF; the archive keys by content, so one document is one message.
  const deduplicated = [...new Map(documents.map((d) => [d.sha256, d])).values()];
  // A maker's Spanish edition of a manual it also publishes in English states the same figures in
  // another language. Converting it costs a reading and a model call for figures already held, so
  // it is dropped here rather than after the money is spent.
  const { keep: unique, dropped } = withoutTranslations(deduplicated);
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
        run: pointer.run,
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

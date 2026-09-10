import { withoutTranslations } from "@origin89/equipment-schema/documents";
import { Sighting } from "@origin89/equipment-schema/sighting";
import { classifierKey } from "./classify.ts";
import { CONVERTER, EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "./reading.ts";
import { pointerKey, readPointer, runPrefix } from "./runs.ts";
import { batches, inputKey, sendAll, type Work } from "./work.ts";

/** Listings per model call. Ten, because answers are matched to listings by position and a long list is where a model starts skipping one. */
export const CLASSIFY_BATCH = 10;

/**
 * What the current classifier has already answered, keyed by the question. A weekly crawl of a
 * shop that did not change asks nothing and costs nothing; only genuinely new listings reach a
 * model.
 *
 * Every answer is one key under one prefix, so the listing grows with the catalogue. A caller
 * classifying several runs lists it once and hands the set to each: listed per seller, it was
 * eighteen calls and nine seconds a seller on the first pass after a new prompt, which over
 * thirty-four sellers is longer than the supervise workflow waits for a pass.
 */
export async function answeredInputs(bucket: R2Bucket): Promise<Set<string>> {
  const answered = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `guesses/by-input/${classifierKey()}/`,
      cursor,
      limit: 1000,
    });
    for (const object of page.objects)
      answered.add(object.key.slice(object.key.lastIndexOf("/") + 1).replace(/\.json$/, ""));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return answered;
}

/**
 * Fill the queue from a finished crawl and write the manifest that says how many parts to expect.
 * The manifest goes first: a reader that finds it knows what a complete run looks like, and a
 * gap in the parts is then visible as a gap rather than as a shorter answer.
 */
export async function classifyRun(
  env: Env,
  seller: string,
  date: string,
  answered?: ReadonlySet<string>,
): Promise<{ parts: number; sightings: number; alreadyAnswered: number }> {
  // Whichever run is current for this seller, not whichever shares today's date.
  const pointer = await readPointer(env.ARCHIVE, pointerKey.sightings(seller));
  if (!pointer) throw new Error(`${seller}: no current run`);
  const prefix = runPrefix.sightings(seller, pointer.run);
  const manifest = await env.ARCHIVE.get(`${prefix}/manifest.json`);
  if (!manifest) throw new Error(`${prefix}: no manifest, the crawl did not finish`);
  const pages = (await manifest.json<{ pages: { page: number }[] }>()).pages.map((p) => p.page);

  const sightings: Sighting[] = [];
  for (const page of pages) {
    const object = await env.ARCHIVE.get(`${prefix}/page-${String(page).padStart(4, "0")}.jsonl`);
    if (!object) throw new Error(`page ${page} of ${seller} is missing`);
    for (const line of (await object.text()).split("\n").filter(Boolean))
      sightings.push(Sighting.parse(JSON.parse(line)));
  }

  const known = answered ?? (await answeredInputs(env.ARCHIVE));
  const keyed = await Promise.all(
    sightings.map(async (s) => ({ sighting: s, key: await inputKey(s) })),
  );
  const fresh = keyed.filter((k) => !known.has(k.key)).map((k) => k.sighting);

  const parts = batches(fresh, CLASSIFY_BATCH);
  await env.ARCHIVE.put(
    `${runPrefix.guesses(seller, pointer.run, classifierKey())}/manifest.json`,
    JSON.stringify(
      {
        seller,
        checkedAt: date,
        by: classifierKey(),
        parts: parts.length,
        sightings: sightings.length,
        alreadyAnswered: sightings.length - fresh.length,
        pages: parts.map((p, i) => ({ page: i + 1, count: p.length })),
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
  return {
    parts: parts.length,
    sightings: sightings.length,
    alreadyAnswered: sightings.length - fresh.length,
  };
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

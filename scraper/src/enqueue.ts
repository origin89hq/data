import { Sighting } from "../../schema/sighting.ts";
import { classifierKey } from "./classify.ts";
import { CONVERTER, EXTRACTOR_ID } from "./reading.ts";
import { batches, inputKey, sendAll, type Work } from "./work.ts";
import { pointerKey, readPointer, runPrefix } from "./runs.ts";

/** Listings per model call. Ten, because answers are matched to listings by position and a long list is where a model starts skipping one. */
export const CLASSIFY_BATCH = 10;

/**
 * Fill the queue from a finished crawl and write the manifest that says how many parts to expect.
 * The manifest goes first: a reader that finds it knows what a complete run looks like, and a
 * gap in the parts is then visible as a gap rather than as a shorter answer.
 */
export async function classifyRun(env: Env, seller: string, date: string): Promise<{ parts: number; sightings: number; alreadyAnswered: number }> {
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
    for (const line of (await object.text()).split("\n").filter(Boolean)) sightings.push(Sighting.parse(JSON.parse(line)));
  }

  // What has already been answered, keyed by the question. A weekly crawl of a shop that did not
  // change asks nothing and costs nothing; only genuinely new listings reach a model.
  const answered = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: `guesses/by-input/${classifierKey()}/`, cursor, limit: 1000 });
    for (const object of page.objects) answered.add(object.key.split("/").pop()!.replace(/\.json$/, ""));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const keyed = await Promise.all(sightings.map(async (s) => ({ sighting: s, key: await inputKey(s) })));
  const fresh = keyed.filter((k) => !answered.has(k.key)).map((k) => k.sighting);

  const parts = batches(fresh, CLASSIFY_BATCH);
  await env.ARCHIVE.put(`${runPrefix.guesses(seller, pointer.run, classifierKey())}/manifest.json`, JSON.stringify({ seller, checkedAt: date, by: classifierKey(), parts: parts.length, sightings: sightings.length, alreadyAnswered: sightings.length - fresh.length, pages: parts.map((p, i) => ({ page: i + 1, count: p.length })) }, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await sendAll(env.WORK, parts.map((batch, i): Work => ({ kind: "classify", seller, date, run: pointer.run, part: i + 1, sightings: batch })));
  return { parts: parts.length, sightings: sightings.length, alreadyAnswered: sightings.length - fresh.length };
}

/**
 * Fill the queue with the maker's own specification pages. These are read by a parser rather than
 * a model, so nothing is approved and nothing is spent: a page a maker publishes for people to
 * read is a page that can be read.
 */
export async function specPagesRun(env: Env, manufacturer: string, date: string, pages: { manufacturer: string; url: string }[]): Promise<{ pages: number }> {
  const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
  if (!pointer) throw new Error(`${manufacturer}: no current run`);
  const mine = pages.filter((p) => p.manufacturer === manufacturer);
  await sendAll(env.WORK, mine.map((p): Work => ({ kind: "spec-table", manufacturer, date, run: pointer.run, url: p.url })));
  return { pages: mine.length };
}

/**
 * Fill the queue from the documents a person approved. Each converted document enqueues its own
 * reading, so one call runs both halves without anything supervising from above.
 */
export async function convertRun(env: Env, manufacturer: string, date: string): Promise<{ documents: number }> {
  const pointer = await readPointer(env.ARCHIVE, pointerKey.documents(manufacturer));
  if (!pointer) throw new Error(`${manufacturer}: no current run`);
  const prefix = runPrefix.documents(manufacturer, pointer.run);
  const manifest = await env.ARCHIVE.get(`${prefix}/manifest.json`);
  if (!manifest) throw new Error(`${prefix}: nothing approved to convert`);
  const { documents } = await manifest.json<{ documents: { url: string; sha256: string; contentType: string }[] }>();
  // Two shops can link the same PDF; the archive keys by content, so one document is one message.
  const unique = [...new Map(documents.map((d) => [d.sha256, d])).values()];
  await env.ARCHIVE.put(`${prefix}/converting.json`, JSON.stringify({ manufacturer, checkedAt: date, converter: CONVERTER, extractedBy: EXTRACTOR_ID, documents: unique }, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await sendAll(env.WORK, unique.map((d): Work => ({ kind: "convert", manufacturer, date, run: pointer.run, sha256: d.sha256, url: d.url, contentType: d.contentType })));
  return { documents: unique.length };
}

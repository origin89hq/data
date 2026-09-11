import { atOnce, R2_AT_ONCE } from "./at-once.ts";
import { todayUtc } from "./feeds.ts";

/**
 * A run is a thing, not a date.
 *
 * Addressing runs by the day they happened was wrong in three separate ways before this: a second
 * crawl of one maker on one day collided with the first, so I picked a different date and put a
 * day that had not happened into the data; the workflow instance could not be created twice under
 * the same name; and two runs' readings ended up in one directory, where a reader merged the
 * output of two different prompts as though it were one answer.
 *
 * So a run has an id of its own and writes only under it. Nothing is ever cleared or overwritten,
 * which means a run in progress cannot damage the last good one. A pointer per entity says which
 * run is current, and moving that pointer is what makes a new run take effect — the same shape as
 * building a catalogue revision before switching to it.
 */
export interface RunId {
  id: string;
  date: string;
}

/** A new run: today's date for reading, and a suffix so two runs today are two runs. */
export function newRun(): RunId {
  const date = todayUtc();
  return { id: `${date}-${crypto.randomUUID().slice(0, 8)}`, date };
}

/** Which run an id belongs to, for a caller that has only the id. */
export function runDate(id: string): string {
  return id.slice(0, 10);
}

/** Where a run writes. Nothing else writes here, so nothing has to be cleared. */
export const runPrefix = {
  documents: (manufacturer: string, run: string) => `documents/${manufacturer}/runs/${run}`,
  sightings: (seller: string, run: string) => `sightings/${seller}/runs/${run}`,
  guesses: (seller: string, run: string, classifier: string) =>
    `guesses/${seller}/runs/${run}/${classifier}`,
};

/** The pointer that says which run is current. Moving it is what makes a run take effect. */
export const pointerKey = {
  documents: (manufacturer: string) => `documents/${manufacturer}/current.json`,
  sightings: (seller: string) => `sightings/${seller}/current.json`,
};

export interface Pointer {
  run: string;
  date: string;
  /** The workflow instance that owns this run, so a caller can approve it without knowing an id. */
  instance?: string;
  startedAt: string;
}

export async function readPointer(bucket: R2Bucket, key: string): Promise<Pointer | undefined> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as Pointer) : undefined;
}

export async function writePointer(bucket: R2Bucket, key: string, pointer: Pointer): Promise<void> {
  // Starts reserve the pointer before creating the workflow. Its first step must preserve that
  // reservation, including an acknowledgement still in flight, and must never replace a newer
  // run after a delayed or restarted workflow wakes up.
  const current = await readPointer(bucket, key);
  if (current?.instance === pointer.instance && current?.run === pointer.run) return;
  if (current) throw new Error("This workflow no longer owns the current run.");
  // Support an existing workflow whose first step predates reservations, if nothing owns the key.
  const written = await bucket.put(key, JSON.stringify(pointer), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (!written) throw new Error("Another workflow reserved the current run.");
}

/**
 * Every entity that has a current run, with the run it points at.
 *
 * The entities are the root's first level, listed with a delimiter, and each pointer is read by
 * name. Listing the root without one returned every run's plans, manifests, conversions and pages
 * to find a hundred pointers, a cost that grew with the archive's history instead of with the
 * number of makers and sellers (#22).
 */
export async function currentRuns(
  bucket: R2Bucket,
  root: "documents" | "sightings",
): Promise<{ entity: string; pointer: Pointer }[]> {
  const entities: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${root}/`, delimiter: "/", cursor, limit: 1000 });
    for (const prefix of page.delimitedPrefixes) entities.push(prefix.slice(root.length + 1, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Read at once: one after another, eighty-five makers were eighty-five round trips (#72).
  const found = await atOnce(entities, R2_AT_ONCE, async (entity) => ({
    entity,
    pointer: await readPointer(bucket, pointerKey[root](entity)),
  }));
  // An entity whose first run has not written its pointer yet has nothing current to report.
  return found
    .flatMap(({ entity, pointer }) => (pointer ? [{ entity, pointer }] : []))
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

/**
 * The top-level prefixes the archive is written under. Making readings content-addressed added
 * `archive/` and nothing told the read endpoint, so every reading came back as HTTP 400 and a
 * maker's figures could not be pulled at all. Deriving the list from the writers is what stops
 * that happening again to the next prefix somebody adds.
 */
export const ARCHIVE_ROOTS = ["sightings", "guesses", "documents", "archive"] as const;

/** Whether a caller may read this prefix out of the archive. */
export function readable(prefix: string): boolean {
  if (prefix.includes("..")) return false;
  return ARCHIVE_ROOTS.some((root) => prefix.startsWith(`${root}/`));
}

/**
 * The one archive key anybody may read without the control token.
 *
 * A page that renders the catalogue has to show a maker's mark, and a token shipped to a browser
 * is a token published. So logos are public and nothing else is: the pattern names the whole key,
 * anchored at both ends, which is what stops `logos/../documents/...` reaching the rest.
 */
export const LOGO_PATH = /^\/logos\/[a-z0-9-]+-\d{2,4}\.png$/;

/**
 * A published dataset file. The whole point of the project is that anybody can take the tables, so
 * these are public too, under a version prefix: `v1` is a promise about the shape of the columns,
 * and a later shape gets `v2` rather than silently changing under somebody's query. An NDJSON
 * file is a load part or nothing: only a numbered part name is admitted, so every one goes
 * through the part's checks and bounds.
 */
export const DATASET_PATH = /^\/v1\/(?:[a-z0-9_]+\.(?:parquet|csv|json)|[a-z0-9_]+_\d{4}\.ndjson)$/;

/** Where a published file lives in the archive. */
export const datasetKey = (name: string): string => `dataset/v1/${name}`;

/** What a published file should be served as. */
export const datasetType = (name: string): string =>
  name.endsWith(".parquet")
    ? "application/vnd.apache.parquet"
    : name.endsWith(".csv")
      ? "text/csv; charset=utf-8"
      : name.endsWith(".ndjson")
        ? "application/x-ndjson; charset=utf-8"
        : "application/json; charset=utf-8";

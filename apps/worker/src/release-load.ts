import { isLoadPart, LOAD_PART_MAX, Release } from "@origin89/equipment-schema/releases";
import {
  activate,
  contractOf,
  countRows,
  createSchema,
  insertRows,
  LOADED_TABLES,
  type LoadRow,
  loadedTables,
  PINNED_RELEASES,
  RECENT_RELEASES_KEPT,
  RetentionFailed,
  releaseRow,
  retain,
  type Store,
} from "./release-store.ts";
import { loadKey, releaseKey } from "./releases.ts";

export interface ReleaseLoadParams {
  release: string;
}

/** The instance id of a release's load: one per release, so a retried publication cannot start a second. */
export const loadInstanceId = (release: string): string => `load-${release}`;
/** A load started by hand, after a reset or a failure: an instance id cannot be used twice, so each reload is its own. */
export const reloadInstanceId = (release: string, at = Date.now()): string =>
  `load-${release}-${at.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

/** Enough of a workflow step to run the load under, or to run it plainly in a test. */
export interface Steps {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export type LoadOutcome =
  /** `retentionError` is set when the release loaded and took its place but letting old ones go failed part way; `retired` is what went before it did. */
  | { outcome: "loaded"; active: boolean; retired: string[]; retentionError?: string }
  | { outcome: "already"; state: string }
  | { outcome: "failed"; reason: string };

/**
 * Load one release into the store, one part a step, and move the active pointer to it when it
 * is the newest publication loaded (#83). Every step is bounded: a part is at most
 * `LOAD_PART_MAX` bytes, inserted in batches D1 accepts. A repeat under a keyed table, a part
 * missing from the archive, or a count that disagrees with the manifest fails the load and
 * leaves the active release as it was.
 */
export async function loadRelease(
  bucket: R2Bucket,
  db: Store,
  step: Steps,
  releaseId: string,
  options: { pinned?: readonly string[]; recent?: number } = {},
): Promise<LoadOutcome> {
  const release = await step.do("read the release", async () => {
    const object = await bucket.get(releaseKey(releaseId));
    if (!object) throw new Error(`release ${releaseId} is not in the archive`);
    return Release.parse(await object.json());
  });
  const plan = release.load;
  if (!plan) return fail(db, step, releaseId, "the release carries no load plan");
  // Every table the release publishes and the store serves has to be in the plan, with no parts
  // when it has no rows: a plan that leaves one out would load a subset and call it the
  // release. A table the store gained after the release was published is not in its files at
  // all, and is loaded empty, so an older pinned or retained release stays loadable.
  const publishes = (table: string) =>
    Object.keys(release.files).some(
      (name) =>
        name === `${table}.csv` ||
        name === `${table}.parquet` ||
        (isLoadPart(name) && name.replace(/_\d{4}\.ndjson$/, "") === table),
    );
  const omitted = Object.keys(LOADED_TABLES).filter(
    (table) => !(table in plan.tables) && publishes(table),
  );
  if (omitted.length) return fail(db, step, releaseId, `the load plan omits ${omitted.join(", ")}`);

  const begun = await step.do("begin", async () => {
    // A load that finds the store on an older schema recreates it, and notes what has to come
    // back beside this release, so the other recent and pinned releases are not left out
    // behind the row this load is about to write.
    await prepareStore(
      bucket,
      db,
      options.pinned,
      (options.recent ?? RECENT_RELEASES_KEPT) + 1,
      releaseId,
    );
    // One statement takes the release: a row is inserted, or a failed one taken over, and any
    // other row (loading, held, or on its way out) leaves it untouched with nothing changed, so
    // two loads of one release started together cannot both proceed into its parts.
    const taken = await db
      .prepare(
        "INSERT INTO releases (id, content, published_at, state, counts, contract) VALUES (?, ?, ?, 'loading', '{}', ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, published_at = excluded.published_at, state = 'loading', error = NULL, counts = '{}', contract = excluded.contract WHERE releases.state = 'failed'",
      )
      // A table the plan names, with rows or none, is one the release was built with.
      .bind(
        releaseId,
        release.content,
        release.at,
        contractOf((t) => t in plan.tables || publishes(t)),
      )
      .run();
    if ((taken.meta?.changes ?? 0) > 0) return { taken: true as const };
    return { taken: false as const, state: (await releaseRow(db, releaseId))?.state ?? "unknown" };
  });
  if (!begun.taken) return { outcome: "already", state: begun.state };

  try {
    const counts: Record<string, number> = {};
    for (const table of loadedTables(plan)) {
      const parts = plan.tables[table]?.parts ?? [];
      let loaded = 0;
      for (const part of parts) {
        loaded += await step.do(`load ${part}`, async () =>
          loadPart(bucket, db, releaseId, table, part, release.files[part]?.sha256),
        );
      }
      const expected = plan.tables[table]?.rows ?? 0;
      if (loaded !== expected)
        throw new Error(`${table}: ${loaded} rows loaded, the plan says ${expected}`);
      counts[table] = loaded;
    }
    // A table the release predates has no rows, and the count says so.
    for (const table of Object.keys(LOADED_TABLES)) counts[table] ??= 0;
    await step.do("verify", async () => {
      for (const [table, expected] of Object.entries(counts)) {
        const stored = await countRows(db, table, releaseId);
        if (stored !== expected)
          throw new Error(`${table}: ${stored} rows in the store, ${expected} were loaded`);
      }
      await db
        .prepare("UPDATE releases SET loaded_at = ?, counts = ? WHERE id = ?")
        .bind(new Date().toISOString(), JSON.stringify(counts), releaseId)
        .run();
    });
  } catch (error) {
    return fail(db, step, releaseId, error instanceof Error ? error.message : String(error));
  }
  // From here the release is loaded and counted. Taking its place is one atomic switch, and
  // letting old releases go is housekeeping: a failure there is reported, not a failed load,
  // and never touches the active pointer.
  // Activation is the one switch that has to land: a store that stays away through its retries
  // leaves the release marked failed, which a reload can pick up, rather than loading for ever.
  let active: boolean;
  try {
    active = await step.do("activate", () => activate(db, releaseId, release.at));
  } catch (error) {
    return fail(db, step, releaseId, error instanceof Error ? error.message : String(error));
  }
  try {
    const retired = await step.do("retain", () => retain(db, options.pinned, options.recent));
    return { outcome: "loaded", active, retired };
  } catch (error) {
    const retentionError = error instanceof Error ? error.message : String(error);
    const retired = error instanceof RetentionFailed ? error.retired : [];
    console.log(
      JSON.stringify({
        message: "release retention failed",
        release: releaseId,
        retentionError,
        retired,
      }),
    );
    return { outcome: "loaded", active, retired, retentionError };
  }
}

async function fail(
  db: Store,
  step: Steps,
  releaseId: string,
  reason: string,
): Promise<LoadOutcome> {
  await step.do("mark failed", async () => {
    await createSchema(db);
    await db
      .prepare(
        // Only a release still loading can fail; one that took its place is never demoted here.
        "INSERT INTO releases (id, content, published_at, state, error, counts) VALUES (?, '', '', 'failed', ?, '{}') ON CONFLICT(id) DO UPDATE SET state = 'failed', error = excluded.error WHERE releases.state = 'loading'",
      )
      .bind(releaseId, reason)
      .run();
  });
  console.log(JSON.stringify({ message: "release load failed", release: releaseId, reason }));
  return { outcome: "failed", reason };
}

/** One part: read by its hash, parsed line by line, inserted; the rows it held. */
async function loadPart(
  bucket: R2Bucket,
  db: Store,
  release: string,
  table: string,
  part: string,
  sha256: string | undefined,
): Promise<number> {
  if (!sha256) throw new Error(`${part} is not in the release's files`);
  const object = await bucket.get(loadKey(sha256));
  if (!object) throw new Error(`${part} (${sha256}) is not in the archive`);
  if (object.size > LOAD_PART_MAX)
    throw new Error(`${part} is ${object.size} bytes, over the bound`);
  const rows: LoadRow[] = [];
  for (const line of (await object.text()).split("\n")) {
    if (!line) continue;
    rows.push(JSON.parse(line) as LoadRow);
  }
  return insertRows(db, table, release, part, rows);
}

/**
 * Put back any pinned release the store lacks or failed to load: a fixture may name a release
 * that retention let go before it was pinned, or the store may have been recreated. Run from
 * the daily schedule, once, rather than from a read, so a release that cannot load is tried
 * once a day and not by every isolate that answers a question. Returns the releases whose
 * load was started.
 */
export async function reloadPinned(
  env: Pick<Env, "ARCHIVE" | "RELEASE_LOAD">,
  db: Store,
  pinned: readonly string[] = PINNED_RELEASES,
): Promise<string[]> {
  // A store just created has no tables yet, and a pinned release is what fills it.
  await prepareStore(env.ARCHIVE, db, pinned);
  const started: string[] = [];
  for (const release of pinned) {
    // A release the store holds, is loading, or is letting go is left alone; one whose load
    // failed is tried again, once a pass, since a pinned release is promised and the archive
    // may have been repaired since.
    const held = await releaseRow(db, release);
    if (held && held.state !== "failed") continue;
    if (!(await env.ARCHIVE.head(releaseKey(release)))) {
      console.log(JSON.stringify({ message: "pinned release not in the archive", release }));
      continue;
    }
    await env.RELEASE_LOAD.create({ id: reloadInstanceId(release), params: { release } });
    started.push(release);
  }
  return started;
}

/** The newest `n` releases in the feed, newest first. */
export async function recentReleases(bucket: R2Bucket, n: number): Promise<string[]> {
  const page = await bucket.list({ prefix: "releases/feed/", limit: n });
  return page.objects.map((o) => o.key.slice(o.key.lastIndexOf("-") + 1, -".json".length));
}

/** The `meta` key under which a restore keeps the releases it has still to start. */
const RESTORE_PENDING = "restore_pending";

/** The releases the store is documented to hold and the archive has: the recent ones and the pinned ones, `except` one left out. */
async function wantedReleases(
  bucket: R2Bucket,
  pinned: readonly string[],
  recent: number,
  except?: string,
): Promise<string[]> {
  const held: string[] = [];
  for (const release of new Set([...(await recentReleases(bucket, recent)), ...pinned]))
    if (release !== except && (await bucket.head(releaseKey(release)))) held.push(release);
  return held;
}

/**
 * The store's tables, and, when that meant recreating them, a note of every release that has to
 * come back: whoever touches an old store first, a load, the daily pass or a read, leaves the
 * restore list behind for `restoreIfEmpty` to work through, so the release that caused the reset
 * is never the only one the store holds afterwards. Returns whether the store was recreated.
 */
export async function prepareStore(
  bucket: R2Bucket,
  db: Store,
  pinned: readonly string[] = PINNED_RELEASES,
  recent = RECENT_RELEASES_KEPT + 1,
  except?: string,
): Promise<boolean> {
  const reset = await createSchema(db);
  if (reset) await setRestorePending(db, await wantedReleases(bucket, pinned, recent, except));
  return reset;
}

async function restorePending(db: Store): Promise<string[]> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(RESTORE_PENDING)
    .first<{ value: string }>();
  const parsed: unknown = row ? JSON.parse(row.value) : [];
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

async function setRestorePending(db: Store, releases: readonly string[]): Promise<void> {
  if (releases.length === 0)
    await db.prepare("DELETE FROM meta WHERE key = ?").bind(RESTORE_PENDING).run();
  else
    await db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .bind(RESTORE_PENDING, JSON.stringify(releases))
      .run();
}

/**
 * Put back what the store is documented to hold. A store with no release at all, a database
 * just created, gets the recent releases and the pinned ones; a store recreated for new tables
 * works through the restore list `prepareStore` left, whatever rows the load that caused the
 * reset has written since. The newest release becomes active as its load lands; the rest are
 * loaded beside it, so a retained release asked for by id and a pinned evaluation are answered
 * after a reset as before it. Otherwise a store with any row, even a failed one, is left as it
 * is: a release that cannot load is a person's to repair with `POST /load`, or the daily
 * pass's for a pinned one, not every isolate's to retry.
 *
 * The releases a restore has still to start are kept in `meta` and taken off as each load is
 * started, so a Workflow that could not be started is tried again by the next call rather than
 * left out for good behind the rows the others wrote. Returns the releases started this call
 * and those still pending.
 */
export async function restoreIfEmpty(
  env: Pick<Env, "ARCHIVE" | "RELEASE_LOAD">,
  db: Store,
  pinned: readonly string[] = PINNED_RELEASES,
  recent = RECENT_RELEASES_KEPT + 1,
): Promise<{ started: string[]; pending: string[] }> {
  await prepareStore(env.ARCHIVE, db, pinned, recent);
  let wanted = await restorePending(db);
  if (wanted.length === 0) {
    const any = await db.prepare("SELECT 1 FROM releases LIMIT 1").first();
    if (any) return { started: [], pending: [] };
    const held = await wantedReleases(env.ARCHIVE, pinned, recent);
    if (held.length === 0) return { started: [], pending: [] };
    await setRestorePending(db, held);
    wanted = held;
  }
  const started: string[] = [];
  const pending: string[] = [];
  for (const release of wanted) {
    try {
      await env.RELEASE_LOAD.create({ id: reloadInstanceId(release), params: { release } });
      started.push(release);
      await setRestorePending(db, [...pending, ...wanted.slice(wanted.indexOf(release) + 1)]);
    } catch (error) {
      pending.push(release);
      console.log(
        JSON.stringify({
          message: "release restore could not start",
          release,
          error: String(error),
        }),
      );
    }
  }
  if (started.length)
    console.log(JSON.stringify({ message: "release store restoring", releases: started, pending }));
  return { started, pending };
}

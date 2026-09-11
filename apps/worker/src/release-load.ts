import { LOAD_PART_MAX, Release } from "@origin89/equipment-schema/releases";
import {
  activate,
  countRows,
  createSchema,
  insertRows,
  LOADED_TABLES,
  type LoadRow,
  loadedTables,
  PINNED_RELEASES,
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
  /** `retentionError` is set when the release loaded and took its place but letting old ones go failed; nothing is lost by it. */
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
  // Every table the store serves has to be in the plan, with no parts when it has no rows: a
  // plan that leaves one out would load a subset and call it the release.
  const omitted = Object.keys(LOADED_TABLES).filter((table) => !(table in plan.tables));
  if (omitted.length) return fail(db, step, releaseId, `the load plan omits ${omitted.join(", ")}`);

  const begun = await step.do("begin", async () => {
    await createSchema(db);
    const existing = await releaseRow(db, releaseId);
    if (existing && existing.state !== "failed") return existing.state;
    await db
      .prepare(
        "INSERT OR REPLACE INTO releases (id, content, published_at, state, counts) VALUES (?, ?, ?, 'loading', '{}')",
      )
      .bind(releaseId, release.content, release.at)
      .run();
    return "loading";
  });
  if (begun !== "loading") return { outcome: "already", state: begun };

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
  const active = await step.do("activate", () => activate(db, releaseId, release.at));
  try {
    const retired = await step.do("retain", () => retain(db, options.pinned, options.recent));
    return { outcome: "loaded", active, retired };
  } catch (error) {
    const retentionError = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({ message: "release retention failed", release: releaseId, retentionError }),
    );
    return { outcome: "loaded", active, retired: [], retentionError };
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
 * Put back any pinned release the store does not hold: a fixture may name a release that
 * retention let go before it was pinned, or the store may have been recreated. Returns the
 * releases whose load was started.
 */
export async function reloadPinned(
  env: Pick<Env, "ARCHIVE" | "RELEASE_LOAD">,
  db: Store,
  pinned: readonly string[] = PINNED_RELEASES,
): Promise<string[]> {
  const started: string[] = [];
  for (const release of pinned) {
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

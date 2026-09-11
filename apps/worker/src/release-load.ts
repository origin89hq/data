import { LOAD_PART_MAX, Release } from "@origin89/equipment-schema/releases";
import {
  activate,
  countRows,
  createSchema,
  insertRows,
  type LoadRow,
  loadedTables,
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

/** Enough of a workflow step to run the load under, or to run it plainly in a test. */
export interface Steps {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export type LoadOutcome =
  | { outcome: "loaded"; active: boolean; retired: string[] }
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
    const active = await step.do("activate", () => activate(db, releaseId, release.at));
    const retired = await step.do("retain", () => retain(db, options.pinned, options.recent));
    return { outcome: "loaded", active, retired };
  } catch (error) {
    return fail(db, step, releaseId, error instanceof Error ? error.message : String(error));
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
        "INSERT INTO releases (id, content, published_at, state, error, counts) VALUES (?, '', '', 'failed', ?, '{}') ON CONFLICT(id) DO UPDATE SET state = 'failed', error = excluded.error",
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
  return insertRows(db, table, release, rows);
}

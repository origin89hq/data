import type { LoadPlan } from "@origin89/equipment-schema/releases";
import pinned from "../pinned-releases.json" with { type: "json" };

/**
 * The store behind the EquipmentApi: every kept release, in D1, keyed by `(release, id)` (#83).
 * A table the API serves is loaded with the columns a lookup needs lifted out and the whole row
 * kept as JSON beside them, so a new answer needs no new column. The rest of a release's tables
 * stay in R2 and Parquet, which is where a query over everything belongs.
 */

/** What a loader needs of D1. The tests give it the same over `node:sqlite`. */
export type Store = Pick<D1Database, "prepare" | "batch" | "exec">;

/** D1 binds at most 100 parameters to one statement, and a batch is one round trip. */
export const PARAMS_PER_STATEMENT = 100;
export const STATEMENTS_PER_BATCH = 50;
/** Rows deleted per round when a release is let go, so one delete never holds the store long. */
export const DELETE_CHUNK = 5_000;

/** Releases kept whatever their age: what an evaluation fixture names, in the repository. */
export const PINNED_RELEASES: readonly string[] = pinned.pinned;
/** Beside the pinned ones and the active one, how many recent releases stay loaded. */
export const RECENT_RELEASES_KEPT = 7;

/** A table the store holds, the columns lifted out of its rows, and whether `id` keys it. */
export interface Loaded {
  columns: readonly string[];
  keyed: boolean;
}

export const LOADED_TABLES: Readonly<Record<string, Loaded>> = {
  models: {
    columns: ["id", "tier", "manufacturer_id", "manufacturer_name", "name", "kind", "reviewed_by"],
    keyed: true,
  },
  model_aliases: { columns: ["model_id", "alias"], keyed: false },
  model_keys: { columns: ["model_id", "key", "name_key", "label", "via"], keyed: false },
  model_dialects: { columns: ["model_id", "dialect_id"], keyed: false },
  specs: { columns: ["id", "model_id"], keyed: true },
  dialects: { columns: ["id", "family", "manufacturer", "confidence"], keyed: true },
  dialect_gotchas: { columns: ["dialect_id", "position", "text"], keyed: false },
  dialect_sources: { columns: ["dialect_id", "position", "source_id", "citation"], keyed: false },
  dialect_kinds: { columns: ["dialect_id", "direction", "position", "kind"], keyed: false },
  sources: { columns: ["id"], keyed: true },
  manufacturers: { columns: ["id", "name"], keyed: true },
  brands: { columns: ["id", "brand", "decision", "manufacturer_id"], keyed: true },
};

/** Every table as `CREATE TABLE IF NOT EXISTS`, run before each load; SQLite makes it idempotent. */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    published_at TEXT NOT NULL,
    state TEXT NOT NULL,
    loaded_at TEXT,
    error TEXT,
    counts TEXT NOT NULL DEFAULT '{}'
  )`,
  ...Object.entries(LOADED_TABLES).map(([table, { columns, keyed }]) => {
    const declared = columns.map((c) => `${c} TEXT`).join(", ");
    const key = keyed ? "PRIMARY KEY (release, id)" : "";
    return `CREATE TABLE IF NOT EXISTS ${table} (release TEXT NOT NULL, ${declared}, row TEXT NOT NULL${key ? `, ${key}` : ""})`;
  }),
  "CREATE INDEX IF NOT EXISTS models_by_maker ON models (release, manufacturer_id, name)",
  "CREATE INDEX IF NOT EXISTS models_by_name ON models (release, name)",
  "CREATE INDEX IF NOT EXISTS model_keys_by_key ON model_keys (release, key)",
  "CREATE INDEX IF NOT EXISTS model_keys_by_name ON model_keys (release, name_key)",
  "CREATE INDEX IF NOT EXISTS model_aliases_by_model ON model_aliases (release, model_id)",
  "CREATE INDEX IF NOT EXISTS specs_by_model ON specs (release, model_id)",
  "CREATE INDEX IF NOT EXISTS model_dialects_by_model ON model_dialects (release, model_id)",
  "CREATE INDEX IF NOT EXISTS dialect_gotchas_by_dialect ON dialect_gotchas (release, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_sources_by_dialect ON dialect_sources (release, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_kinds_by_dialect ON dialect_kinds (release, dialect_id)",
];

export async function createSchema(db: Store): Promise<void> {
  for (const statement of SCHEMA) await db.exec(statement.replace(/\s+/g, " "));
}

/** A row as the load part gives it: the build's row with absent fields left out. */
export type LoadRow = Record<string, string | number | boolean | undefined>;

const stringOf = (value: string | number | boolean | undefined): string | null =>
  value === undefined ? null : typeof value === "string" ? value : String(value);

/**
 * Insert a part's rows, in statements of as many rows as fit under D1's parameter limit and
 * batches of a bounded number of statements. A repeat under a keyed table is refused by the
 * primary key, and the error names it.
 */
export async function insertRows(
  db: Store,
  table: string,
  release: string,
  rows: readonly LoadRow[],
): Promise<number> {
  const loaded = LOADED_TABLES[table];
  if (!loaded) return 0;
  const width = loaded.columns.length + 2;
  const perStatement = Math.max(1, Math.floor(PARAMS_PER_STATEMENT / width));
  const columns = ["release", ...loaded.columns, "row"].join(", ");
  const statements: D1PreparedStatement[] = [];
  let inserted = 0;
  const flush = async () => {
    if (statements.length === 0) return;
    await db.batch(statements.splice(0));
  };
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    const values = chunk
      .map(() => `(${Array.from({ length: width }, () => "?").join(", ")})`)
      .join(", ");
    const params = chunk.flatMap((row) => [
      release,
      ...loaded.columns.map((c) => stringOf(row[c])),
      JSON.stringify(row),
    ]);
    statements.push(
      db.prepare(`INSERT INTO ${table} (${columns}) VALUES ${values}`).bind(...params),
    );
    inserted += chunk.length;
    if (statements.length >= STATEMENTS_PER_BATCH) await flush();
  }
  await flush();
  return inserted;
}

/** How many rows a release has in a table. */
export async function countRows(db: Store, table: string, release: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE release = ?`)
    .bind(release)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface ReleaseRow {
  id: string;
  content: string;
  published_at: string;
  state: "loading" | "active" | "retained" | "failed";
  loaded_at: string | null;
  error: string | null;
  counts: string;
}

export async function releaseRow(db: Store, id: string): Promise<ReleaseRow | null> {
  return db.prepare("SELECT * FROM releases WHERE id = ?").bind(id).first<ReleaseRow>();
}

export async function activeRelease(db: Store): Promise<ReleaseRow | null> {
  return db.prepare("SELECT * FROM releases WHERE state = 'active'").first<ReleaseRow>();
}

/**
 * Make a loaded release the active one, unless the active one was published later: a slow load
 * of an older publication must not overtake a newer one. Either way the release stays loaded.
 */
export async function activate(db: Store, id: string, publishedAt: string): Promise<boolean> {
  const current = await activeRelease(db);
  if (current && current.id !== id && current.published_at > publishedAt) {
    await db.prepare("UPDATE releases SET state = 'retained' WHERE id = ?").bind(id).run();
    return false;
  }
  await db.batch([
    db
      .prepare("UPDATE releases SET state = 'retained' WHERE state = 'active' AND id != ?")
      .bind(id),
    db.prepare("UPDATE releases SET state = 'active' WHERE id = ?").bind(id),
  ]);
  return true;
}

/**
 * Which releases to keep: every pinned one, the active one, and the most recent
 * `RECENT_RELEASES_KEPT` by publication. Returns the ids let go.
 */
export async function retain(
  db: Store,
  pinnedIds: readonly string[] = PINNED_RELEASES,
  recent = RECENT_RELEASES_KEPT,
): Promise<string[]> {
  const all = (
    await db
      .prepare("SELECT id, published_at, state FROM releases ORDER BY published_at DESC, id")
      .all<Pick<ReleaseRow, "id" | "published_at" | "state">>()
  ).results;
  const keep = new Set<string>(pinnedIds);
  for (const r of all) if (r.state === "active") keep.add(r.id);
  for (const r of all
    .filter((r) => r.state === "active" || r.state === "retained")
    .slice(0, recent))
    keep.add(r.id);
  const gone: string[] = [];
  for (const r of all) {
    if (keep.has(r.id) || r.state === "loading") continue;
    await forget(db, r.id);
    gone.push(r.id);
  }
  return gone;
}

/** Delete a release's rows in chunks, then the release itself. */
export async function forget(db: Store, id: string): Promise<void> {
  for (const table of Object.keys(LOADED_TABLES)) {
    for (;;) {
      const result = await db
        .prepare(
          `DELETE FROM ${table} WHERE release = ? AND rowid IN (SELECT rowid FROM ${table} WHERE release = ? LIMIT ${DELETE_CHUNK})`,
        )
        .bind(id, id)
        .run();
      if ((result.meta?.changes ?? 0) < DELETE_CHUNK) break;
    }
  }
  await db.prepare("DELETE FROM releases WHERE id = ?").bind(id).run();
}

/** The tables of a plan the store loads, in the plan's order. */
export function loadedTables(plan: LoadPlan): string[] {
  return Object.keys(plan.tables).filter((table) => table in LOADED_TABLES);
}

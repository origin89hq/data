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
  model_dialects: {
    columns: ["model_id", "dialect_id", "evidence_kind", "confidence"],
    keyed: false,
  },
  model_dialect_sources: {
    columns: ["model_id", "dialect_id", "position", "source_id", "citation"],
    keyed: false,
  },
  specs: { columns: ["id", "model_id"], keyed: true },
  dialects: { columns: ["id", "family", "manufacturer", "confidence"], keyed: true },
  dialect_gotchas: { columns: ["dialect_id", "position", "text"], keyed: false },
  dialect_sources: { columns: ["dialect_id", "position", "source_id", "citation"], keyed: false },
  dialect_kinds: { columns: ["dialect_id", "direction", "position", "kind"], keyed: false },
  dialect_readings: { columns: ["dialect_id", "position", "metric", "at"], keyed: false },
  dialect_codes: { columns: ["dialect_id", "position", "code_table", "code"], keyed: false },
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
    // A position is an order, and orders as one; a keyed row has an id: every other lifted
    // column is text.
    const declared = columns
      .map((c) =>
        c === "position"
          ? `${c} INTEGER`
          : keyed && c === "id"
            ? `${c} TEXT NOT NULL`
            : `${c} TEXT`,
      )
      .join(", ");
    const key = keyed ? "PRIMARY KEY (release, id)" : "";
    // `part` names the load part a row came from, so a retried part step can take its own rows
    // back out before inserting them again and never doubles a row or trips its own key.
    return `CREATE TABLE IF NOT EXISTS ${table} (release TEXT NOT NULL, part TEXT NOT NULL, ${declared}, row TEXT NOT NULL${key ? `, ${key}` : ""})`;
  }),
  ...Object.keys(LOADED_TABLES).map(
    (table) => `CREATE INDEX IF NOT EXISTS ${table}_by_part ON ${table} (release, part)`,
  ),
  "CREATE INDEX IF NOT EXISTS models_by_maker ON models (release, manufacturer_id, name)",
  "CREATE INDEX IF NOT EXISTS models_by_name ON models (release, name)",
  "CREATE INDEX IF NOT EXISTS model_keys_by_key ON model_keys (release, key)",
  "CREATE INDEX IF NOT EXISTS model_keys_by_name ON model_keys (release, name_key)",
  "CREATE INDEX IF NOT EXISTS model_aliases_by_model ON model_aliases (release, model_id)",
  "CREATE INDEX IF NOT EXISTS specs_by_model ON specs (release, model_id)",
  "CREATE INDEX IF NOT EXISTS model_dialects_by_model ON model_dialects (release, model_id)",
  "CREATE INDEX IF NOT EXISTS model_dialect_sources_by_link ON model_dialect_sources (release, model_id, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_gotchas_by_dialect ON dialect_gotchas (release, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_sources_by_dialect ON dialect_sources (release, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_kinds_by_dialect ON dialect_kinds (release, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_readings_by_dialect ON dialect_readings (release, dialect_id)",
  "CREATE INDEX IF NOT EXISTS dialect_codes_by_dialect ON dialect_codes (release, dialect_id)",
];

/**
 * The shape of the store. `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that
 * exists, so a change to `LOADED_TABLES` or `SCHEMA` bumps this, and a store stamped with an
 * older version is dropped and recreated whole: it is a copy of releases still in R2, and
 * `POST /load` puts one back.
 */
export const SCHEMA_VERSION = "2";

/**
 * Create the store's tables, or recreate them all when the stamped version is not this one.
 * Returns whether it reset. The drops, the tables and the new stamp go in one batch, which D1
 * runs as one transaction, and the stamp is inserted rather than replaced: two isolates that
 * read the same old stamp during a rollout cannot both reset, since the second's insert finds
 * the key taken, its whole batch rolls back, and it reads again to find the store current
 * with whatever the first has loaded since.
 */
export async function createSchema(db: Store): Promise<boolean> {
  await db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (;;) {
    const stamped = await db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .first<{ value: string }>();
    if (stamped?.value === SCHEMA_VERSION) {
      for (const statement of SCHEMA) await db.exec(statement.replace(/\s+/g, " "));
      return false;
    }
    // A store with tables and no stamp is one from before stamps existed: as old as any.
    const hadTables = Boolean(
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releases'")
        .first(),
    );
    const reset = stamped ? true : hadTables;
    try {
      await db.batch([
        db
          .prepare("DELETE FROM meta WHERE key = 'schema_version' AND value = ?")
          .bind(stamped?.value ?? ""),
        db
          .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
          .bind(SCHEMA_VERSION),
        ...(reset
          ? [...Object.keys(LOADED_TABLES), "releases"].map((table) =>
              db.prepare(`DROP TABLE IF EXISTS ${table}`),
            )
          : []),
        ...SCHEMA.map((statement) => db.prepare(statement.replace(/\s+/g, " "))),
      ]);
    } catch (error) {
      if (!/UNIQUE constraint failed: meta\.key/.test(String(error))) throw error;
      continue;
    }
    if (reset)
      console.log(
        JSON.stringify({
          message: "release store recreated",
          from: stamped?.value,
          to: SCHEMA_VERSION,
        }),
      );
    return reset;
  }
}

/** A row as the load part gives it: the build's row with absent fields left out. */
export type LoadRow = Record<string, string | number | boolean | undefined>;

const stringOf = (value: string | number | boolean | undefined): string | null =>
  value === undefined ? null : typeof value === "string" ? value : String(value);
/** A lifted value bound as the column holds it: a position as a number, the rest as text. */
const bound = (
  column: string,
  value: string | number | boolean | undefined,
): string | number | null =>
  column === "position" && typeof value === "number" ? value : stringOf(value);

/**
 * Insert a part's rows, in statements of as many rows as fit under D1's parameter limit and
 * batches of a bounded number of statements. A repeat under a keyed table is refused by the
 * primary key, and the error names it.
 */
export async function insertRows(
  db: Store,
  table: string,
  release: string,
  part: string,
  rows: readonly LoadRow[],
): Promise<number> {
  const loaded = LOADED_TABLES[table];
  if (!loaded) return 0;
  // Whatever an earlier try of this part left behind goes first, so the step is safe to retry.
  await db.prepare(`DELETE FROM ${table} WHERE release = ? AND part = ?`).bind(release, part).run();
  const width = loaded.columns.length + 3;
  const perStatement = Math.max(1, Math.floor(PARAMS_PER_STATEMENT / width));
  const columns = ["release", "part", ...loaded.columns, "row"].join(", ");
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
      part,
      ...loaded.columns.map((c) => bound(c, row[c])),
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
  /** `deleting` is a release retention has begun to let go: its rows are on their way out and the next pass finishes them. */
  state: "loading" | "active" | "retained" | "failed" | "deleting";
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
  // One batch, which D1 runs as one transaction: the active row steps aside only for a newer
  // publication, and this release takes over only when nothing else is active once it has, so
  // two loads finishing together cannot both read "no active release" and both take it.
  await db.batch([
    db
      .prepare(
        "UPDATE releases SET state = 'retained' WHERE state = 'active' AND id != ? AND published_at <= ?",
      )
      .bind(id, publishedAt),
    db
      .prepare(
        "UPDATE releases SET state = 'active' WHERE id = ? AND state = 'loading' AND NOT EXISTS (SELECT 1 FROM releases WHERE state = 'active' AND id != ?)",
      )
      .bind(id, id),
    db
      .prepare("UPDATE releases SET state = 'retained' WHERE id = ? AND state = 'loading'")
      .bind(id),
  ]);
  const row = await releaseRow(db, id);
  return row?.state === "active";
}

/**
 * Which releases to keep: every pinned one, the active one, and the most recent
 * `RECENT_RELEASES_KEPT` by publication. Returns the ids let go.
 */
/** A retention pass that stopped part way: what it had let go before it failed. */
export class RetentionFailed extends Error {
  override name = "RetentionFailed";
  readonly retired: string[];
  constructor(message: string, retired: string[]) {
    super(message);
    this.retired = retired;
  }
}

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
  // The recent ones beside the active one, not counting it: active plus seven, as documented.
  for (const r of all.filter((r) => r.state === "retained").slice(0, recent)) keep.add(r.id);
  const gone: string[] = [];
  for (const r of all) {
    // A deletion that stopped part way is finished before anything else is judged, pinned or
    // not: its rows are half gone, and a pinned one is put back whole by the pinned reload.
    if (r.state !== "deleting" && (keep.has(r.id) || r.state === "loading")) continue;
    try {
      await forget(db, r.id);
    } catch (error) {
      throw new RetentionFailed(error instanceof Error ? error.message : String(error), gone);
    }
    gone.push(r.id);
  }
  return gone;
}

/**
 * Delete a release's rows in chunks, then the release itself. The row is marked `deleting`
 * first, so a reader that checks its release before answering finds it gone at once rather
 * than reading tables emptying one by one behind it, and so a deletion that stops part way
 * stays on the list for the next retention pass to finish rather than leaving rows behind
 * that nothing names any more.
 */
export async function forget(db: Store, id: string): Promise<void> {
  await db.prepare("UPDATE releases SET state = 'deleting' WHERE id = ?").bind(id).run();
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
  await db.prepare("DELETE FROM releases WHERE id = ? AND state = 'deleting'").bind(id).run();
}

/** The tables of a plan the store loads, in the plan's order. */
export function loadedTables(plan: LoadPlan): string[] {
  return Object.keys(plan.tables).filter((table) => table in LOADED_TABLES);
}

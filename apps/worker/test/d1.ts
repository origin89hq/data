import { DatabaseSync } from "node:sqlite";
import type { Store } from "../src/release-store.ts";

/**
 * Enough of D1 over `node:sqlite` for the release store: `prepare().bind().all/first/run`,
 * `batch` as one transaction, and `exec`. D1 is SQLite, so the SQL is the same; what this
 * fakes is the API around it and nothing about the engine.
 */
export function d1Double(): Store & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  type Bound = { sql: string; params: unknown[] };
  const statement = (sql: string, params: unknown[] = []) => {
    const bound: Bound = { sql, params };
    const prepared = {
      bind: (...next: unknown[]) => statement(sql, next),
      all: async <T>() => ({
        results: db.prepare(sql).all(...(params as never[])) as T[],
        success: true,
        meta: {},
      }),
      first: async <T>(column?: string) => {
        const row = db.prepare(sql).get(...(params as never[])) as
          | Record<string, unknown>
          | undefined;
        if (row === undefined) return null;
        return (column ? row[column] : row) as T;
      },
      run: async () => {
        const result = db.prepare(sql).run(...(params as never[]));
        return { success: true, meta: { changes: Number(result.changes) }, results: [] };
      },
      raw: async () => [],
      __bound: bound,
    };
    return prepared as unknown as D1PreparedStatement & { __bound: Bound };
  };
  return {
    db,
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      db.exec("BEGIN");
      try {
        const out: D1Result<T>[] = [];
        for (const s of statements) {
          const { sql, params } = (s as unknown as { __bound: Bound }).__bound;
          const result = db.prepare(sql).run(...(params as never[]));
          out.push({
            success: true,
            meta: { changes: Number(result.changes) },
            results: [],
          } as unknown as D1Result<T>);
        }
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

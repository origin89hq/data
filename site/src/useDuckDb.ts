import { useEffect, useState } from "react";
import type { Index } from "./api.ts";

export interface Query {
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
}

type State =
  | { ready: false; error?: string }
  | { ready: true; tables: string[]; run: (sql: string) => Promise<Query> };

/**
 * DuckDB in the reader's own browser, reading the published Parquet over HTTP ranges.
 *
 * Nothing is uploaded and nothing is proxied: the same query written here is the query you would
 * write on your own machine, against the same URLs. Each published table becomes a view, so a
 * question asks the file rather than a copy of it.
 */
export function useDuckDb(index: Index | undefined): State {
  const [state, setState] = useState<State>({ ready: false });

  useEffect(() => {
    if (!index) return;
    let closed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        const duckdb = await import("@duckdb/duckdb-wasm");
        const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
        const worker = await duckdb.createWorker(bundle.mainWorker!);
        const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        const connection = await db.connect();
        cleanup = () => {
          void connection.close();
          void db.terminate();
          void worker.terminate();
        };

        const tables = Object.keys(index.files)
          .filter((file) => file.endsWith(".parquet"))
          .map((file) => file.replace(".parquet", ""));
        for (const table of tables) {
          await connection.query(`CREATE VIEW "${table}" AS SELECT * FROM read_parquet('${index.files[`${table}.parquet`]!.url}')`);
        }
        if (closed) return;

        setState({
          ready: true,
          tables,
          run: async (sql) => {
            const started = performance.now();
            const result = await connection.query(sql);
            return {
              columns: result.schema.fields.map((field) => field.name),
              // A console, not an export. Anything larger is a download rather than a page.
              rows: result.toArray().slice(0, 500).map((row) => row.toJSON() as Record<string, unknown>),
              ms: performance.now() - started,
            };
          },
        });
      } catch (error) {
        if (!closed) setState({ ready: false, error: String(error).slice(0, 140) });
      }
    })();

    return () => {
      closed = true;
      cleanup?.();
    };
  }, [index]);

  return state;
}

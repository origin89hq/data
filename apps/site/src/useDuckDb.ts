import { useCallback, useEffect, useState } from "react";
import type { Index } from "./api.ts";
import { queryRow } from "./query-row.ts";
import { explorerTables, readTable } from "./tables.ts";

export interface Query {
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
}

export type State =
  | { ready: false; message?: string; error?: string; retry?: () => void }
  | { ready: true; tables: string[]; run: (sql: string) => Promise<Query> };

/**
 * DuckDB in the reader's own browser, over the published Parquet.
 *
 * Each table is fetched whole and handed to DuckDB as bytes. DuckDB-WASM reads a remote file with
 * synchronous requests that have no timeout, so one request lost on the network left the explorer
 * connecting forever; a fetch notices the stall and asks again. Nothing is uploaded and nothing is
 * proxied, and each published table becomes a view.
 */
export function useDuckDb(index: Index | undefined): State {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [state, setState] = useState<State>({
    ready: false,
    message: "Finding the published data…",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately restarts this read after failure.
  useEffect(() => {
    if (!index) return;
    let closed = false;
    let cleanup: (() => void) | undefined;
    const downloads = new AbortController();
    setState({ ready: false, message: "Preparing the data explorer…" });

    void (async () => {
      try {
        const duckdb = await import("@duckdb/duckdb-wasm");
        if (closed) return;
        const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
        if (closed) return;
        if (!bundle.mainWorker) throw new Error("No DuckDB worker is available for this browser");
        const worker = await duckdb.createWorker(bundle.mainWorker);
        if (closed) {
          worker.terminate();
          return;
        }
        const db = new duckdb.AsyncDuckDB(
          new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
          worker,
        );
        cleanup = () => {
          void db.terminate().catch(() => worker.terminate());
        };
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        if (closed) return;
        await db.open({});
        if (closed) return;
        const connection = await db.connect();
        if (closed) return;

        setState({ ready: false, message: "Connecting to the published tables…" });
        const tables = explorerTables(index.files);
        const read = await Promise.all(
          tables.map(async (table) => ({
            table,
            bytes: await readTable(table, { signal: downloads.signal }),
          })),
        );
        for (const { table, bytes } of read) {
          if (closed) return;
          await db.registerFileBuffer(table.file, bytes);
          if (closed) return;
          await connection.query(table.sql);
        }
        if (closed) return;

        setState({
          ready: true,
          tables: tables.map((table) => table.name),
          run: async (sql) => {
            const started = performance.now();
            const result = await connection.query(sql);
            return {
              columns: result.schema.fields.map((field) => field.name),
              // A console, not an export. Anything larger is a download rather than a page.
              rows: result
                .toArray()
                .slice(0, 500)
                .map((row) => queryRow(row.toJSON() as Record<string, unknown>)),
              ms: performance.now() - started,
            };
          },
        });
      } catch (error) {
        // One table that failed leaves no reason to finish downloading the others.
        downloads.abort();
        cleanup?.();
        cleanup = undefined;
        if (!closed) setState({ ready: false, error: String(error).slice(0, 140), retry });
      }
    })();

    return () => {
      closed = true;
      downloads.abort();
      cleanup?.();
    };
  }, [index, attempt, retry]);

  return state;
}

import { useEffect, useState } from "react";
import type { Index } from "./api.ts";
import { queryRow } from "./query-row.ts";

export interface Query {
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
}

export type State =
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
    setState({ ready: false });

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
        // Probe range support rather than buffering each entire remote file at startup.
        await db.open({
          filesystem: {
            reliableHeadRequests: false,
            allowFullHTTPReads: true,
            forceFullHTTPReads: false,
          },
        });
        if (closed) return;
        const connection = await db.connect();
        if (closed) return;

        const views = parquetViews(index.files).filter(({ name }) =>
          ["models", "specs", "sources", "dialects", "model_dialects"].includes(name),
        );
        const tables = views.map((view) => view.name);
        for (const view of views) {
          if (closed) return;
          await db.registerFileURL(view.url, view.url, duckdb.DuckDBDataProtocol.HTTP, false);
          if (closed) return;
          await connection.query(view.sql);
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
              rows: result
                .toArray()
                .slice(0, 500)
                .map((row) => queryRow(row.toJSON() as Record<string, unknown>)),
              ms: performance.now() - started,
            };
          },
        });
      } catch (error) {
        cleanup?.();
        cleanup = undefined;
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

/** Quote filenames and URLs from the published index as SQL data. */
export function parquetViews(files: Index["files"]): { name: string; url: string; sql: string }[] {
  return Object.entries(files)
    .filter(([file]) => file.endsWith(".parquet"))
    .map(([file, entry]) => {
      const name = file.slice(0, -".parquet".length);
      if (!name) throw new Error("Parquet file has no table name");
      const identifier = name.replaceAll('"', '""');
      const url = entry.url.replaceAll("'", "''");
      return {
        name,
        url: entry.url,
        sql: `CREATE VIEW "${identifier}" AS SELECT * FROM read_parquet('${url}')`,
      };
    });
}

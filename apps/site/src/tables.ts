import type { Index } from "./api.ts";

/** The published tables the explorer turns into views. */
const EXPLORER_TABLES: ReadonlySet<string> = new Set([
  "models",
  "specs",
  "sources",
  "dialects",
  "model_dialects",
]);

/** A table past this belongs in a download, not in a page's memory. */
export const MAX_TABLE_BYTES = 32 * 1024 * 1024;

/** A published table the explorer reads whole and hands to DuckDB. */
export interface Table {
  /** The view a query names. */
  name: string;
  /**
   * The name its bytes are registered under inside DuckDB. Never the URL: DuckDB-WASM sends a
   * synchronous HEAD for any name that starts with `http`, even one backed by a registered buffer,
   * and a synchronous request has no timeout.
   */
  file: string;
  url: string;
  sql: string;
}

/** The explorer's tables that the index publishes, in the index's order. */
export function explorerTables(files: Index["files"]): Table[] {
  return Object.entries(files).flatMap(([file, entry]) => {
    if (!file.endsWith(".parquet")) return [];
    const name = file.slice(0, -".parquet".length);
    if (!EXPLORER_TABLES.has(name)) return [];
    return [
      {
        name,
        file,
        url: entry.url,
        sql: `CREATE VIEW "${name}" AS SELECT * FROM read_parquet('${file}')`,
      },
    ];
  });
}

/** Why a table could not be read, and whether asking again could help. */
export class TableReadError extends Error {
  /** A stall, a dropped connection or a server error; not a missing file or an oversized one. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "TableReadError";
    this.retryable = retryable;
  }
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface ReadOptions {
  /** Stops the read, and any attempt still to come. */
  signal?: AbortSignal;
  /** An attempt that goes this long without headers or bytes is abandoned. */
  stallMs?: number;
  /** Attempts in all, the first included. */
  attempts?: number;
  retryDelayMs?: number;
  maxBytes?: number;
  fetch?: Fetch;
}

/**
 * One table's bytes, whole.
 *
 * A request can be lost on the way without the connection failing: a QUIC stream whose packets
 * never arrive waits indefinitely. So an attempt is abandoned when neither headers nor bytes have
 * arrived for `stallMs`, however slowly the file was arriving before, and asked again up to
 * `attempts` times.
 */
export async function readTable(table: Table, options: ReadOptions = {}): Promise<Uint8Array> {
  const {
    signal,
    stallMs = 15_000,
    attempts = 3,
    retryDelayMs = 1_000,
    maxBytes = MAX_TABLE_BYTES,
    fetch: get = (url, init) => fetch(url, init),
  } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readOnce(table, { get, stallMs, maxBytes, signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof TableReadError) || !error.retryable || attempt >= attempts) {
        throw error;
      }
      await delay(retryDelayMs, signal);
    }
  }
}

async function readOnce(
  table: Table,
  {
    get,
    stallMs,
    maxBytes,
    signal,
  }: { get: Fetch; stallMs: number; maxBytes: number; signal: AbortSignal | undefined },
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const request = new AbortController();
  const forward = () => request.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      request.abort();
    }, stallMs);
  };
  try {
    watch();
    const response = await get(table.url, { signal: request.signal });
    if (!response.ok) {
      throw new TableReadError(`${table.file} answered ${response.status}`, response.status >= 500);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TableReadError(`${table.file} answered without a body`, false);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      watch();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new TableReadError(
          `${table.file} is larger than the explorer holds (${maxBytes} bytes)`,
          false,
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof TableReadError) throw error;
    if (signal?.aborted) throw signal.reason;
    if (stalled) {
      throw new TableReadError(`${table.file} stopped arriving for ${stallMs / 1000} s`, true);
    }
    throw new TableReadError(`${table.file} could not be fetched: ${String(error)}`, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

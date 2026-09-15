import type { Index } from "./api.ts";

/** The published tables the explorer turns into views. */
const EXPLORER_TABLES: ReadonlySet<string> = new Set([
  "models",
  "specs",
  "sources",
  "dialects",
  "model_dialects",
  "properties",
  "manufacturers",
]);

/** A table past this belongs in a download, not in a page's memory. */
export const MAX_TABLE_BYTES = 32 * 1024 * 1024;

/** Parquet opens and closes with these four bytes. */
const PARQUET_MAGIC = "PAR1";

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
  /** Its size and digest in the index, which tell the published file from an older copy. */
  bytes: number;
  sha256: string;
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
        bytes: entry.bytes,
        sha256: entry.sha256,
        sql: `CREATE VIEW "${name}" AS SELECT * FROM read_parquet('${file}')`,
      },
    ];
  });
}

/** Why a table could not be read, and whether asking again could help. */
export class TableReadError extends Error {
  /**
   * A stall, a dropped connection, a body cut short or a server error; not a missing file or an
   * oversized one.
   */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "TableReadError";
    this.retryable = retryable;
  }
}

type Fetch = (url: string, init: { signal: AbortSignal; cache: RequestCache }) => Promise<Response>;

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
 * One table's bytes, whole, as the index publishes them.
 *
 * A request can be lost on the way without the connection failing: a QUIC stream whose packets
 * never arrive waits indefinitely. So an attempt is abandoned when neither headers nor bytes have
 * arrived for `stallMs`, however slowly the file was arriving before, and asked again up to
 * `attempts` times.
 *
 * A finished download can still be the wrong bytes: a body that ended early, or the browser's
 * cached copy of an earlier release. A body shorter than its length or without Parquet's closing
 * bytes is asked again, and so is one whose size or digest differs from the index. Every attempt
 * after the first bypasses the browser's cache, where a bad copy would otherwise come back. A
 * complete file fetched that way is kept even when it differs from the index, because a publish
 * uploads its files before its index.
 */
export async function readTable(
  table: Table,
  options: ReadOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const {
    signal,
    stallMs = 15_000,
    attempts = 3,
    retryDelayMs = 1_000,
    maxBytes = MAX_TABLE_BYTES,
    fetch: get = (url, init) => fetch(url, init),
  } = options;
  for (let attempt = 1; ; attempt += 1) {
    const cache: RequestCache = attempt === 1 ? "default" : "reload";
    try {
      const bytes = await readOnce(table, { get, stallMs, maxBytes, signal, cache });
      if (cache === "reload" || (await published(table, bytes))) return bytes;
      // Only a copy fetched past the cache is trusted over the index; with no attempt left to
      // fetch one, an unmatched copy is refused rather than handed to DuckDB.
      if (attempt >= attempts) {
        throw new TableReadError(`${table.file} does not match the index`, true);
      }
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
    cache,
  }: {
    get: Fetch;
    stallMs: number;
    maxBytes: number;
    signal: AbortSignal | undefined;
    cache: RequestCache;
  },
): Promise<Uint8Array<ArrayBuffer>> {
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
    const response = await get(table.url, { signal: request.signal, cache });
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
    // An encoded body's length is not the length of the bytes it decodes to.
    const declared = response.headers.get("content-encoding")
      ? null
      : response.headers.get("content-length");
    if ((declared !== null && Number(declared) !== size) || !isParquet(bytes)) {
      throw new TableReadError(`${table.file} arrived incomplete (${size} bytes)`, true);
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

/** A body cut short loses Parquet's closing bytes; one that never was Parquet lacks both. */
function isParquet(bytes: Uint8Array): boolean {
  const magic = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
  return (
    bytes.byteLength >= 12 &&
    magic(0) === PARQUET_MAGIC &&
    magic(bytes.byteLength - 4) === PARQUET_MAGIC
  );
}

/** Whether these are the bytes the index describes. */
async function published(table: Table, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (bytes.byteLength !== table.bytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === table.sha256;
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

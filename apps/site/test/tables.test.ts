import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Index } from "../src/api.ts";
import { explorerTables, readTable, type Table, TableReadError } from "../src/tables.ts";

type Init = { signal: AbortSignal; cache: RequestCache };

const PAR1 = [80, 65, 82, 49];
/** Bytes that open and close the way a Parquet file does. */
const parquet = (...middle: number[]) => [...PAR1, ...middle, ...PAR1];
const digest = (bytes: number[]) =>
  createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");

/** The file the index describes. */
const release = parquet(1, 2, 3, 4, 5);

const table: Table = {
  name: "specs",
  file: "specs.parquet",
  url: "https://data.origin89.com/v1/specs.parquet",
  bytes: release.length,
  sha256: digest(release),
  sql: "",
};

const entry = (file: string) => ({
  rows: 1,
  bytes: file.length,
  sha256: digest([...file].map((c) => c.charCodeAt(0))),
  url: `https://data.origin89.com/v1/${file}`,
});

/**
 * A response that sends these chunks and ends, or with `stall` sends them and goes quiet. `length`
 * declares a Content-Length, which a body cut short does not reach.
 */
function body(
  chunks: number[][],
  signal: AbortSignal,
  { stall = false, length }: { stall?: boolean; length?: number } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        if (stall) signal.addEventListener("abort", () => controller.error(signal.reason));
        else controller.close();
      },
    }),
    length === undefined ? undefined : { headers: { "content-length": String(length) } },
  );
}

/** A request whose answer never comes. */
const silent = ({ signal }: Init) =>
  new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });

/** A fetch that gives each attempt the next answer, and records how each attempt used the cache. */
function scripted(...answers: ((init: Init) => Promise<Response>)[]) {
  const calls: string[] = [];
  const caches: RequestCache[] = [];
  const get = (url: string, init: Init) => {
    calls.push(url);
    caches.push(init.cache);
    const answer = answers[calls.length - 1];
    return answer
      ? answer(init)
      : Promise.reject(new Error(`no answer for attempt ${calls.length}`));
  };
  return { get, calls, caches };
}

test("the explorer opens its own tables by file name; nothing else in the index reaches SQL", () => {
  const files: Index["files"] = {
    "dialects.csv": entry("dialects.csv"),
    "dialects.parquet": entry("dialects.parquet"),
    "models_0001.ndjson": entry("models_0001.ndjson"),
    "models.parquet": entry("models.parquet"),
    "model_keys.parquet": entry("model_keys.parquet"),
    'specs"; DROP VIEW models; --.parquet': entry("specs.parquet"),
    ".parquet": entry(".parquet"),
    "sources.parquet": { ...entry("sources.parquet"), url: "https://data.example/it's.parquet" },
  };
  const tables = explorerTables(files);
  assert.deepEqual(
    tables.map(({ name, file, url }) => [name, file, url]),
    [
      ["dialects", "dialects.parquet", "https://data.origin89.com/v1/dialects.parquet"],
      ["models", "models.parquet", "https://data.origin89.com/v1/models.parquet"],
      ["sources", "sources.parquet", "https://data.example/it's.parquet"],
    ],
  );
  // Each table carries what the index says of it, to check the download against.
  assert.equal(tables[1]?.bytes, files["models.parquet"]?.bytes);
  assert.equal(tables[1]?.sha256, files["models.parquet"]?.sha256);
  // The URL is fetched, never interpolated: DuckDB reads the bytes registered under the file name.
  assert.equal(
    tables[2]?.sql,
    `CREATE VIEW "sources" AS SELECT * FROM read_parquet('sources.parquet')`,
  );
  assert.deepEqual(explorerTables({}), []);
});

test("a table arrives whole across its chunks, from the browser's cache when it has the release", async () => {
  const { get, calls, caches } = scripted(async ({ signal }) =>
    body([release.slice(0, 3), release.slice(3, 9), release.slice(9)], signal, {
      length: release.length,
    }),
  );
  assert.deepEqual([...(await readTable(table, { fetch: get }))], release);
  assert.deepEqual(calls, ["https://data.origin89.com/v1/specs.parquet"]);
  assert.deepEqual(caches, ["default"]);
});

test("an attempt that stalls before or during its body is abandoned and asked again", async () => {
  const { get, calls, caches } = scripted(
    silent,
    async ({ signal }) => body([release.slice(0, 6)], signal, { stall: true }),
    async ({ signal }) => body([release], signal),
  );
  // The bytes from the attempt that stalled midway are not kept.
  assert.deepEqual(
    [...(await readTable(table, { fetch: get, stallMs: 20, retryDelayMs: 0 }))],
    release,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(caches, ["default", "reload", "reload"]);
});

test("a table that keeps stalling fails after its attempts and says why", async () => {
  const { get, calls } = scripted(silent, silent, silent, silent);
  await assert.rejects(
    readTable(table, { fetch: get, stallMs: 20, retryDelayMs: 0, attempts: 3 }),
    (error) =>
      error instanceof TableReadError &&
      error.retryable &&
      error.message === "specs.parquet stopped arriving for 0.02 s",
  );
  assert.equal(calls.length, 3);
});

test("a body that ends short of its length, or of Parquet's closing bytes, is asked again past the cache", async () => {
  const { get, calls, caches } = scripted(
    async ({ signal }) => body([release.slice(0, 8)], signal, { length: release.length }),
    // No length to compare, but the closing magic bytes are missing.
    async ({ signal }) => body([release.slice(0, -2)], signal),
    async ({ signal }) => body([release], signal),
  );
  assert.deepEqual([...(await readTable(table, { fetch: get, retryDelayMs: 0 }))], release);
  assert.equal(calls.length, 3);
  assert.deepEqual(caches, ["default", "reload", "reload"]);

  const short = async ({ signal }: Init) => body([release.slice(0, -1)], signal);
  const always = scripted(short, short, short);
  await assert.rejects(
    readTable(table, { fetch: always.get, retryDelayMs: 0, attempts: 3 }),
    (error) =>
      error instanceof TableReadError &&
      error.retryable &&
      error.message === "specs.parquet arrived incomplete (12 bytes)",
  );
  assert.equal(always.calls.length, 3);
});

test("a cached copy of another release, by size or by digest, is replaced by the server's file", async () => {
  // A complete file of another size: no retry delay, since nothing failed to arrive.
  const older = scripted(
    async ({ signal }) => body([parquet(9, 9, 9, 9, 9, 9, 9)], signal),
    async ({ signal }) => body([release], signal),
  );
  const started = performance.now();
  assert.deepEqual(
    [...(await readTable(table, { fetch: older.get, retryDelayMs: 5_000 }))],
    release,
  );
  assert.ok(performance.now() - started < 1_000);
  assert.deepEqual(older.caches, ["default", "reload"]);

  // Same size, different bytes: only the digest tells them apart.
  const sameSize = scripted(
    async ({ signal }) => body([parquet(1, 2, 3, 4, 6)], signal),
    async ({ signal }) => body([release], signal),
  );
  assert.deepEqual([...(await readTable(table, { fetch: sameSize.get }))], release);
  assert.deepEqual(sameSize.caches, ["default", "reload"]);
});

test("with no attempt left to fetch past the cache, a copy that differs from the index is refused", async () => {
  const { get, calls, caches } = scripted(async ({ signal }) =>
    body([parquet(9, 9, 9, 9, 9, 9, 9)], signal),
  );
  await assert.rejects(
    readTable(table, { fetch: get, attempts: 1 }),
    (error) =>
      error instanceof TableReadError &&
      error.retryable &&
      error.message === "specs.parquet does not match the index",
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(caches, ["default"]);
});

test("the server's complete file is kept when the index has not caught up with it", async () => {
  const newer = parquet(1, 2, 3, 4, 5, 6, 7);
  const { get, caches } = scripted(
    async ({ signal }) => body([newer], signal),
    async ({ signal }) => body([newer], signal),
  );
  assert.deepEqual([...(await readTable(table, { fetch: get }))], newer);
  assert.deepEqual(caches, ["default", "reload"]);
});

test("a server error is asked again; a missing file is not", async () => {
  const flaky = scripted(
    async () => new Response(null, { status: 503 }),
    async ({ signal }) => body([release], signal),
  );
  assert.deepEqual([...(await readTable(table, { fetch: flaky.get, retryDelayMs: 0 }))], release);
  assert.equal(flaky.calls.length, 2);

  const missing = scripted(async () => new Response("no such file", { status: 404 }));
  await assert.rejects(readTable(table, { fetch: missing.get, retryDelayMs: 0 }), {
    name: "TableReadError",
    message: "specs.parquet answered 404",
  });
  assert.equal(missing.calls.length, 1);
});

test("a body at the limit is kept; one past it is refused and not asked again", async () => {
  const limit = release.length;
  const exact = scripted(async ({ signal }) =>
    body([release.slice(0, 5), release.slice(5)], signal),
  );
  assert.equal((await readTable(table, { fetch: exact.get, maxBytes: limit })).byteLength, limit);

  const over = scripted(async ({ signal }) =>
    body([release.slice(0, 5), [...release.slice(5), 0]], signal),
  );
  await assert.rejects(readTable(table, { fetch: over.get, maxBytes: limit, retryDelayMs: 0 }), {
    message: `specs.parquet is larger than the explorer holds (${limit} bytes)`,
  });
  assert.equal(over.calls.length, 1);
});

test("leaving the page stops the read without another attempt", async () => {
  const leaving = new AbortController();
  const { get, calls } = scripted((init) => {
    queueMicrotask(() => leaving.abort(new Error("left the page")));
    return silent(init);
  }, silent);
  await assert.rejects(
    readTable(table, { fetch: get, signal: leaving.signal, stallMs: 10_000, retryDelayMs: 0 }),
    { message: "left the page" },
  );
  assert.equal(calls.length, 1);

  await assert.rejects(readTable(table, { fetch: get, signal: leaving.signal }), {
    message: "left the page",
  });
  assert.equal(calls.length, 1);
});

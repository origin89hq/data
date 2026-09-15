import assert from "node:assert/strict";
import { test } from "node:test";
import type { Index } from "../src/api.ts";
import { explorerTables, readTable, type Table, TableReadError } from "../src/tables.ts";

type Init = { signal: AbortSignal };

const table: Table = {
  name: "specs",
  file: "specs.parquet",
  url: "https://data.origin89.com/v1/specs.parquet",
  sql: "",
};

const entry = (file: string) => ({
  rows: 1,
  bytes: 1,
  sha256: "0",
  url: `https://data.origin89.com/v1/${file}`,
});

/** A response that sends these chunks and ends, or with `stall` sends them and goes quiet. */
function body(chunks: number[][], signal: AbortSignal, stall = false): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        if (stall) signal.addEventListener("abort", () => controller.error(signal.reason));
        else controller.close();
      },
    }),
  );
}

/** A request whose answer never comes. */
const silent = ({ signal }: Init) =>
  new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });

/** A fetch that gives each attempt the next answer, and counts the attempts. */
function scripted(...answers: ((init: Init) => Promise<Response>)[]) {
  const calls: string[] = [];
  const get = (url: string, init: Init) => {
    calls.push(url);
    const answer = answers[calls.length - 1];
    return answer
      ? answer(init)
      : Promise.reject(new Error(`no answer for attempt ${calls.length}`));
  };
  return { get, calls };
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
  // The URL is fetched, never interpolated: DuckDB reads the bytes registered under the file name.
  assert.equal(
    tables[2]?.sql,
    `CREATE VIEW "sources" AS SELECT * FROM read_parquet('sources.parquet')`,
  );
  assert.deepEqual(explorerTables({}), []);
});

test("a table arrives whole across its chunks", async () => {
  const { get, calls } = scripted(async ({ signal }) => body([[1, 2], [3], [4, 5]], signal));
  assert.deepEqual([...(await readTable(table, { fetch: get }))], [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, ["https://data.origin89.com/v1/specs.parquet"]);
});

test("an attempt that stalls before or during its body is abandoned and asked again", async () => {
  const { get, calls } = scripted(
    silent,
    async ({ signal }) => body([[1]], signal, true),
    async ({ signal }) => body([[7, 8]], signal),
  );
  // The byte from the attempt that stalled midway is not kept.
  assert.deepEqual(
    [...(await readTable(table, { fetch: get, stallMs: 20, retryDelayMs: 0 }))],
    [7, 8],
  );
  assert.equal(calls.length, 3);
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

test("a server error is asked again; a missing file is not", async () => {
  const flaky = scripted(
    async () => new Response(null, { status: 503 }),
    async ({ signal }) => body([[9]], signal),
  );
  assert.deepEqual([...(await readTable(table, { fetch: flaky.get, retryDelayMs: 0 }))], [9]);
  assert.equal(flaky.calls.length, 2);

  const missing = scripted(async () => new Response("no such file", { status: 404 }));
  await assert.rejects(readTable(table, { fetch: missing.get, retryDelayMs: 0 }), {
    name: "TableReadError",
    message: "specs.parquet answered 404",
  });
  assert.equal(missing.calls.length, 1);
});

test("a body at the limit is kept; one past it is refused and not asked again", async () => {
  const exact = scripted(async ({ signal }) =>
    body(
      [
        [1, 2, 3],
        [4, 5],
      ],
      signal,
    ),
  );
  assert.equal((await readTable(table, { fetch: exact.get, maxBytes: 5 })).byteLength, 5);

  const over = scripted(async ({ signal }) =>
    body(
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      signal,
    ),
  );
  await assert.rejects(readTable(table, { fetch: over.get, maxBytes: 5, retryDelayMs: 0 }), {
    message: "specs.parquet is larger than the explorer holds (5 bytes)",
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

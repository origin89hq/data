import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { READS_PER_REQUEST } from "@origin89/equipment-schema/provenance";
import { readingsOf } from "../tools/gate/archive.ts";

/**
 * The batching is what keeps the daily pull inside its hour, and it is also the only thing
 * standing between the caller and a Worker that refuses the request. A batch one document too
 * large is a whole maker's figures lost to a 400, so the arithmetic is worth pinning.
 */
const digest = (n: number) => String(n).padStart(64, "0");
const asked: { documents: string[]; readers: string[] }[] = [];
let answer: (n: number) => Response = () => new Response("");
const realFetch = globalThis.fetch;

beforeEach(() => {
  asked.length = 0;
  process.env.OFFGRID_BASE_URL = "https://data.example";
  process.env.OFFGRID_CONTROL_TOKEN = "the-real-token";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)));
    return answer(asked.length);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  answer = () => new Response("");
});

test("every document is asked for exactly once, in batches the Worker will accept", () => {
  const documents = Array.from({ length: 1500 }, (_, i) => digest(i));
  const readers = ["text", "vision", "table"];
  return readingsOf(documents, readers, true).then(() => {
    for (const batch of asked) {
      assert.ok(
        batch.documents.length * batch.readers.length <= READS_PER_REQUEST,
        `a batch of ${batch.documents.length} by ${batch.readers.length} is over the cap the Worker refuses`,
      );
      assert.deepEqual(batch.readers, readers);
    }
    assert.deepEqual(
      asked.flatMap((batch) => batch.documents),
      documents,
    );
    assert.equal(asked.length, 3, "1500 documents by three readers is three batches, not 1500");
  });
});

test("one reader fills a batch to the cap and never one past it", async () => {
  // The arithmetic that would bite is a batch sized by document count alone. The cap counts
  // reads, not documents, so the reader list is half of it: six readers means a third as many
  // documents per request, and a batch that ignored them would be refused every time.
  await readingsOf(
    Array.from({ length: READS_PER_REQUEST + 1 }, (_, i) => digest(i)),
    ["text"],
    true,
  );
  assert.deepEqual(
    asked.map((batch) => batch.documents.length),
    [READS_PER_REQUEST, 1],
  );

  asked.length = 0;
  const six = Array.from({ length: 6 }, (_, i) => `r${i}`);
  await readingsOf(
    Array.from({ length: 334 }, (_, i) => digest(i)),
    six,
    true,
  );
  assert.deepEqual(
    asked.map((batch) => batch.documents.length),
    [333, 1],
  );
});

test("a maker with nothing converted makes no request at all", async () => {
  assert.equal(await readingsOf([], ["text"], true), "");
  assert.equal(asked.length, 0, "asking for no documents is a request the Worker would refuse");
});

test("the batches concatenate into one stream, and each keeps its own last value whole", async () => {
  answer = (n) => new Response(`{"batch":${n}}\n`);
  const ndjson = await readingsOf(
    Array.from({ length: READS_PER_REQUEST * 2 }, (_, i) => digest(i)),
    ["text"],
    true,
  );
  assert.equal(ndjson, '{"batch":1}\n{"batch":2}\n');
});

test("a batch the Worker refuses stops the pull rather than returning the ones that worked", async () => {
  // Swallowing it would fold a maker's figures from half its documents and then delete the spec
  // records of the other half, as figures nothing reads any more.
  answer = (n) => (n === 2 ? new Response("over the cap", { status: 400 }) : new Response(""));
  await assert.rejects(
    readingsOf(
      Array.from({ length: READS_PER_REQUEST * 2 }, (_, i) => digest(i)),
      ["text"],
      true,
    ),
    /\/readings: HTTP 400 over the cap/,
  );
});

test("a reader list that cannot be batched is refused here, not by the Worker", async () => {
  // No readers divides by nothing: the batch became the whole document list, which the Worker
  // refuses for a reason that says nothing about the readers. More readers than the cap sizes
  // every batch at one document and has each of them refused in turn.
  await assert.rejects(readingsOf([digest(1)], [], true), /needs 1 to 2000 readers, not 0/);
  await assert.rejects(
    readingsOf(
      [digest(1)],
      Array.from({ length: READS_PER_REQUEST + 1 }, (_, i) => `r${i}`),
      true,
    ),
    /needs 1 to 2000 readers, not 2001/,
  );
  assert.equal(asked.length, 0, "neither may reach the Worker");
});

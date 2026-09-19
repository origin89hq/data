import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import {
  EXTRACTOR_ID,
  READS_PER_REQUEST,
  readerKey,
  VISION_EXTRACTOR_ID,
} from "@origin89/equipment-schema/provenance";
import { PULLED_READERS, readingsOf } from "../tools/gate/archive.ts";

/**
 * The batching is what keeps the daily pull inside its hour, and it is also the only thing
 * standing between the caller and a Worker that refuses the request. A batch one document too
 * large is a whole maker's figures lost to a 400, so the arithmetic is worth pinning.
 */
const digest = (n: number) => String(n).padStart(64, "0");
const asked: { maker: string; documents: string[]; readers: string[] }[] = [];
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
  return readingsOf("rolls", documents, readers, true).then(() => {
    for (const batch of asked) {
      assert.ok(
        batch.documents.length * batch.readers.length <= READS_PER_REQUEST,
        `a batch of ${batch.documents.length} by ${batch.readers.length} is over the cap the Worker refuses`,
      );
      assert.deepEqual(batch.readers, readers);
      assert.equal(batch.maker, "rolls", "every batch names the maker its readings were read for");
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
    "rolls",
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
    "rolls",
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
  assert.equal(await readingsOf("rolls", [], ["text"], true), "");
  assert.equal(asked.length, 0, "asking for no documents is a request the Worker would refuse");
});

test("the batches concatenate into one stream, and each keeps its own last value whole", async () => {
  answer = (n) => new Response(`{"batch":${n}}\n`);
  const ndjson = await readingsOf(
    "rolls",
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
      "rolls",
      Array.from({ length: READS_PER_REQUEST * 2 }, (_, i) => digest(i)),
      ["text"],
      true,
    ),
    /\/readings: HTTP 400 over the cap/,
  );
});

test("the figures pull asks for the text reader and the table parser, and not the page reader", () => {
  assert.deepEqual(PULLED_READERS, [readerKey(EXTRACTOR_ID), "table_spec-table_v1"]);
  assert.ok(
    !PULLED_READERS.includes(readerKey(VISION_EXTRACTOR_ID)),
    "its readings file figures under the wrong models (#28) and keep rate-limited pages as read (#29)",
  );
  assert.match(
    readFileSync(new URL("../tools/gate/pull-specs.ts", import.meta.url), "utf8"),
    /readingsOf\(\s*manufacturer,[\s\S]*?PULLED_READERS,\s*remote,?\s*\)/,
    "the pull must ask for this list, for its own maker, not a copy of its own",
  );
});

test("a reader list that cannot be batched is refused here, not by the Worker", async () => {
  // No readers divides by nothing: the batch became the whole document list, which the Worker
  // refuses for a reason that says nothing about the readers. More readers than the cap sizes
  // every batch at one document and has each of them refused in turn.
  await assert.rejects(
    readingsOf("rolls", [digest(1)], [], true),
    /needs 1 to 2000 readers, not 0/,
  );
  await assert.rejects(
    readingsOf(
      "rolls",
      [digest(1)],
      Array.from({ length: READS_PER_REQUEST + 1 }, (_, i) => `r${i}`),
      true,
    ),
    /needs 1 to 2000 readers, not 2001/,
  );
  assert.equal(asked.length, 0, "neither may reach the Worker");
});

test("the figures pull writes through the guard that keeps a person's figures, and deletes past it too", () => {
  const source = readFileSync(new URL("../tools/gate/pull-specs.ts", import.meta.url), "utf8");
  assert.match(source, /pullWrites\(records\.specs, read, candidates\)/);
  // Main's own figure is kept only through the helper that never takes one a person holds (#175).
  assert.match(
    source,
    /const reconciled = keepFullerOnMain\(held\.write, records\.specs\);\s*for \(const spec of reconciled\.write\) collected\.set\(spec\.id, spec\);/,
  );
  assert.match(source, /staleFigures\(records\.specs, \{ models: mine, produced, reread \}\)/);
  // Only a document read to its end can take a figure back; one stopped at the cap is partial.
  assert.match(source, /const reread = new Set\(\s*everyReading\s*\.filter\(readInFull\)/);
  assert.match(source, /for \(const spec of dryRun \? \[\] : staleSpecs\) \{\s*rmSync\(/);
});

test("the figures pull leaves out what a person rejected: documents, product names and figures", () => {
  const source = readFileSync(new URL("../tools/gate/pull-specs.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /readings\.readings = readings\.readings\.filter\(\(reading\) => !isRejected\(reading\)\)/,
  );
  assert.match(source, /if \(rejectsProduct\(rejections, name\)\) \{/);
  assert.match(
    source,
    /const specs = given\.filter\(\(spec\) => !rejectsFigure\(rejections, spec\)\)/,
  );
  assert.ok(
    source.indexOf("!isRejected(reading)") < source.indexOf("if (addModels)"),
    "a rejected document is left out before any model is minted from it",
  );
  assert.equal(
    (source.match(/if \(!rejectsFigure\(rejections, spec\)\) candidate\(spec\)/g) ?? []).length,
    2,
    "a rejected figure is compared neither as a repeated row nor from a set-aside edition",
  );
  assert.match(
    source,
    /if \(document\.products\.length === 0 \|\| isRejected\(document\)\) continue;/,
  );
});

test("the figures pull reads the translated editions it sets aside for comparison only, and cites documents by address", () => {
  const source = readFileSync(new URL("../tools/gate/pull-specs.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const comparisonOnly = \(\s*await creditedReadings\([\s\S]*?\.\.\.everyReading\.filter[\s\S]*?byLanguage\.dropped,?\s*\]/,
  );
  assert.match(source, /for \(const document of comparisonOnly\)[\s\S]*?candidate\(spec\)/);
  assert.match(
    source,
    /const comparisonOnly = \(\s*await creditedReadings\(/,
    "a retailer's set-aside editions are credited before they are compared",
  );
  // The loop's own body, up to the brace that closes it: the figures to write are gathered, then
  // placed under their ids, so a window of characters after the loop no longer says what it does.
  const comparing = /for \(const document of comparisonOnly\) \{\n([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.match(comparing ?? "", /candidate\(spec\)/);
  assert.doesNotMatch(
    comparing ?? "",
    /collected\.set|toWrite\.push|usedSources\.set/,
    "a comparison-only document is neither written nor cited",
  );
  assert.match(
    source,
    /documentUrls\.get\(spec\.source\) \?\? sources\.get\(spec\.source\)\?\.url/,
  );
});

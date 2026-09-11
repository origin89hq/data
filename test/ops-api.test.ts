import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approve,
  archive,
  parsePlan,
  parsePublished,
  parseRuns,
  parseState,
  pipeline,
  type RunStatus,
  read,
  SessionError,
  startRun,
  supervision,
} from "../apps/site/src/ops/api.ts";

const run: RunStatus = {
  kind: "maker",
  entity: "victron",
  run: "run-1",
  date: "2026-09-11",
  instance: "maker-victron-run-1",
  status: "waiting",
  error: null,
};
const plan = {
  manufacturer: run.entity,
  checkedAt: run.date,
  documents: [{ url: "https://docs.example.com/manual.pdf", host: "docs.example.com", bytes: 0 }],
};

test("operations parsers preserve missing counts and reject corrupt nested data", () => {
  const parsed = parseState({
    makers: [{ maker: "victron", waitingOn: "nothing", fetched: 0 }],
    sellers: [{ seller: "shop" }],
  });
  assert.equal(parsed.makers[0]?.fetched, 0);
  assert.equal(parsed.makers[0]?.offered, undefined);
  for (const fetched of [-1, 1.5, "1", null])
    assert.throws(() =>
      parseState({ makers: [{ maker: "victron", waitingOn: "nothing", fetched }], sellers: [] }),
    );
  assert.throws(() =>
    parseState({ makers: [], sellers: [{ seller: "shop", classified: { parts: 4 } }] }),
  );
  assert.throws(() => parseRuns({ runs: [{ ...run, kind: "alien" }] }));
  assert.equal(parseRuns({ runs: [run] }).get("maker:victron")?.instance, run.instance);
});

test("document plans must belong to the selected run and use matching, credential-free web hosts", () => {
  assert.deepEqual(parsePlan(plan, run), plan);
  // Where a document came from survives parsing, so the approver can tell a record's citation
  // from a crawl find; a marker that is not exactly true is refused.
  const provenance = {
    ...plan,
    documents: [
      {
        url: "https://docs.example.com/manual.pdf",
        host: "docs.example.com",
        bytes: 12,
        foundOn: "https://docs.example.com/product/a",
      },
      {
        url: "https://docs.example.com/cited.pdf",
        host: "docs.example.com",
        bytes: 34,
        cited: true,
      },
    ],
  };
  assert.deepEqual(parsePlan(provenance, run), provenance);
  assert.throws(() =>
    parsePlan({ ...plan, documents: [{ ...provenance.documents[1], cited: "yes" }] }, run),
  );
  for (const value of [
    { ...plan, checkedAt: "2026-09-10" },
    { ...plan, manufacturer: "another" },
    { ...plan, documents: [{ url: "javascript:alert(1)", host: "" }] },
    { ...plan, documents: [{ url: "https://elsewhere.com/file", host: "docs.example.com" }] },
    {
      ...plan,
      documents: [{ url: "https://user:pass@docs.example.com/file", host: "docs.example.com" }],
    },
  ])
    assert.throws(() => parsePlan(value, run));
});

test("a workflow service outage keeps archive state but an expired session stops the workspace", async (t) => {
  let status = 503;
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "/state"
      ? Response.json({ makers: [], sellers: [{ seller: "shop", sightings: 0 }] })
      : Response.json({}, { status }),
  );
  const value = await pipeline();
  assert.equal(value.sellers[0]?.sightings, 0);
  assert.match(value.workflowError ?? "", /503/);
  assert.equal(value.runs.size, 0);
  status = 403;
  await assert.rejects(pipeline(), SessionError);
});

test("read failures, cancellation, missing reports and oversized responses are explicit", async (t) => {
  let response = () => new Response("", { status: 404 });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return response();
  });
  assert.equal(await supervision(), null);
  await assert.rejects(read("/state", AbortSignal.abort()), /abort/i);
  response = () =>
    Response.json({ error: "The immutable record snapshot is unavailable." }, { status: 409 });
  await assert.rejects(read("/release-compare"), /immutable record snapshot/);
  response = () => new Response("x".repeat(4097), { status: 503 });
  await assert.rejects(read("/releases"), /503/);
  response = () => new Response(" ");
  await assert.rejects(read("/state"), /No file/);
  response = () => new Response("x".repeat(5 * 1024 * 1024 + 1));
  await assert.rejects(read("/state"), /too large/);
});

test("approval targets the reviewed instance and never posts after a changed pointer or invalid limit", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let current = { run: run.run, instance: run.instance };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json(init?.method === "POST" ? { sent: true, to: run.instance } : current);
  });
  await approve(run, 1, 2);
  const post = calls.find((call) => call.init?.method === "POST");
  assert.equal(post?.url, `/approve?id=${run.instance}`);
  assert.equal(post?.init?.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(post?.init?.body)), { approved: true, limit: 1 });
  calls.length = 0;
  current = { run: "run-2", instance: "maker-victron-run-2" };
  await assert.rejects(approve(run, 1, 2), /current run changed/);
  assert.equal(
    calls.some((call) => call.init?.method === "POST"),
    false,
  );
  calls.length = 0;
  for (const limit of [0, 3, 1.5, Number.NaN])
    await assert.rejects(approve(run, limit, 2), /limit/);
  assert.equal(calls.length, 0);
});

test("an approval with a lost response is reported as uncertain and is never retried", async (t) => {
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++;
      throw Error("connection lost");
    }
    return Response.json({ run: run.run, instance: run.instance });
  });
  await assert.rejects(approve(run, 1, 2), /may have been accepted/);
  assert.equal(posts, 1);
});

test("fresh runs validate settings and leave the atomic status check to the server", async (t) => {
  const posts: string[] = [];
  let status = 409;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(url);
      return Response.json({ id: "new-run", outcome: "created" }, { status });
    }
    return Response.json({ run: run.run, instance: run.instance });
  });
  await assert.rejects(startRun("maker", "victron", [], 20), /domains/);
  await assert.rejects(startRun("seller", "shop", [], 501), /page limit/);
  await assert.rejects(startRun("maker", "victron", ["docs.example.com"], 20, run), /409/);
  assert.equal(posts.length, 1, "invalid settings must not post");
  status = 200;
  assert.deepEqual(await startRun("maker", "victron", ["docs.example.com"], 20, run), {
    id: "new-run",
    reconciled: false,
  });
  assert.equal(posts[0], "/maker?id=victron&domains=docs.example.com&pages=20");
});

test("archive listings cannot quietly mix files from another run", async (t) => {
  let keys = ["documents/victron/runs/run-1/plan.json"];
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys }));
  assert.deepEqual(await archive(run), keys);
  keys = [...keys, "documents/victron/runs/run-2/plan.json"];
  await assert.rejects(archive(run), /outside this run/);
});

test("all unconfirmed 2xx mutation acknowledgements are uncertain and never retried", async (t) => {
  let response: () => Response = () => new Response("");
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++;
      return response();
    }
    return Response.json({ run: run.run, instance: run.instance });
  });
  for (const mutation of [
    () => approve(run, 1, 2),
    () => startRun("maker", "victron", ["docs.example.com"], 20),
  ]) {
    for (const reply of [
      () => new Response('{"id":'),
      () => new Response(null, { status: 204 }),
      () => Response.json(null),
      () => Response.json([]),
      () => Response.json({}),
      () => Response.json({ id: 42, sent: true, to: "another-run" }),
      () => Response.json({ id: "", sent: false, to: run.instance }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error("body lost"));
            },
          }),
        ),
    ]) {
      posts = 0;
      response = reply;
      await assert.rejects(mutation(), /may have been accepted.*Refresh and inspect the run/);
      assert.equal(posts, 1);
    }
    for (const status of [401, 403]) {
      posts = 0;
      response = () => new Response("expired", { status });
      await assert.rejects(mutation(), SessionError);
      assert.equal(posts, 1);
    }
  }
});

test("the dashboard distinguishes confirmation of an existing run from fresh creation", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ id: "reserved-run", outcome: "reconciled", status: "complete" }),
  );
  assert.deepEqual(await startRun("seller", "shop", [], 20), {
    id: "reserved-run",
    reconciled: true,
  });
});

test("the published index keeps a file without a row count, and refuses a corrupt one", () => {
  const sha256 = "a".repeat(64);
  const files = parsePublished({
    files: {
      "specs.csv": { rows: 3, bytes: 10, sha256 },
      "vocabulary.json": { bytes: 20, sha256 },
    },
  });
  assert.deepEqual(files, [
    { name: "specs.csv", rows: 3, bytes: 10, sha256 },
    { name: "vocabulary.json", rows: undefined, bytes: 20, sha256 },
  ]);
  assert.throws(
    () => parsePublished({ files: { "specs.csv": { rows: -1, bytes: 10, sha256 } } }),
    /invalid count/,
  );
  for (const table of ["specs.csv", "specs.parquet"])
    assert.throws(
      () => parsePublished({ files: { [table]: { bytes: 10, sha256 } } }),
      /invalid count/,
      `${table} is a table, so a missing row count is refused`,
    );
  assert.throws(
    () => parsePublished({ files: { "../evil.json": { bytes: 1, sha256 } } }),
    /unsupported filename/,
  );
  assert.throws(
    () => parsePublished({ files: { "specs.csv": { bytes: 1, sha256: "nope" } } }),
    /invalid content hash/,
  );
});

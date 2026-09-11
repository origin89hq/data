import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approve,
  archive,
  parsePlan,
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

test("fresh runs validate settings and refuse to replace a newly active workflow", async (t) => {
  const posts: string[] = [];
  let status = "running";
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(url);
      return Response.json({ id: "new-run" });
    }
    if (url === "/runs") return Response.json({ runs: [{ ...run, status }] });
    return Response.json({ run: run.run, instance: run.instance });
  });
  await assert.rejects(startRun("maker", "victron", [], 20), /domains/);
  await assert.rejects(startRun("seller", "shop", [], 501), /page limit/);
  await assert.rejects(
    startRun("maker", "victron", ["docs.example.com"], 20, run),
    /workflow is running/,
  );
  assert.deepEqual(posts, []);
  status = "complete";
  assert.equal(await startRun("maker", "victron", ["docs.example.com"], 20, run), "new-run");
  assert.equal(posts[0], "/maker?id=victron&domains=docs.example.com&pages=20");
});

test("archive listings cannot quietly mix files from another run", async (t) => {
  let keys = ["documents/victron/runs/run-1/plan.json"];
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys }));
  assert.deepEqual(await archive(run), keys);
  keys = [...keys, "documents/victron/runs/run-2/plan.json"];
  await assert.rejects(archive(run), /outside this run/);
});

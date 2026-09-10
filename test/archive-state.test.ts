import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { makerStates } from "../tools/gate/archive.ts";

/** The Worker's /state as `answer` says, and a record of every path asked for. */
function mockState(t: TestContext, answer: () => Response) {
  const before = process.env.OFFGRID_CONTROL_TOKEN;
  process.env.OFFGRID_CONTROL_TOKEN = "test-only";
  t.after(() => {
    if (before === undefined) delete process.env.OFFGRID_CONTROL_TOKEN;
    else process.env.OFFGRID_CONTROL_TOKEN = before;
  });
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    paths.push(
      new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname,
    );
    return answer();
  });
  return paths;
}

test("the makers come from the Worker's /state", async (t) => {
  const maker = { maker: "srne", date: "2026-09-10", sent: 1, converted: 1, waitingOn: "reading" };
  const paths = mockState(t, () => Response.json({ sellers: [], makers: [maker] }));
  assert.deepEqual(await makerStates(false), [maker]);
  assert.deepEqual(paths, ["/state"]);
});

test("a base URL that is not this Worker says so, rather than failing to parse a body", async (t) => {
  mockState(t, () => new Response("Not Found", { status: 404 }));
  await assert.rejects(
    makerStates(false),
    /\/state answered 404; is OFFGRID_BASE_URL this Worker\?/,
  );
});

test("a Worker that refuses the token is an error with its answer, not an empty list", async (t) => {
  mockState(t, () => new Response("a bearer token is required", { status: 401 }));
  await assert.rejects(makerStates(false), /\/state: HTTP 401 a bearer token is required/);
});

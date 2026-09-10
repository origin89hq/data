import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { bearerFor, loginPath, readLogin, saveLogin } from "../tools/credential.ts";
import { login } from "../tools/login.ts";

const WORKER = "https://worker.example";
const START = Date.parse("2026-09-10T12:00:00Z");

/** A config directory of the test's own, and no control token from the shell running it. */
function isolated(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "offgrid-login-"));
  const before = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OFFGRID_CONTROL_TOKEN: process.env.OFFGRID_CONTROL_TOKEN,
  };
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.OFFGRID_CONTROL_TOKEN;
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

type Poll = { access_token: string; expires_in?: number } | { error: string; interval?: number };

/**
 * GitHub's device flow and the Worker's two sign-in routes. GitHub answers each poll with the next
 * of `polls`; the Worker answers /auth/me with `me`.
 */
function device(t: TestContext, polls: Poll[], me: () => Response) {
  isolated(t);
  const asked: string[] = [];
  const waited: number[] = [];
  const said: string[] = [];
  let now = START;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    asked.push(`${request.method} ${request.url}`);
    switch (request.url) {
      case `${WORKER}/auth/app`:
        return Response.json({ clientId: "Iv23test", org: "origin89hq", team: "working-group" });
      case "https://github.com/login/device/code":
        assert.deepEqual(await request.json(), { client_id: "Iv23test" });
        return Response.json({
          device_code: "device-code",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      case "https://github.com/login/oauth/access_token": {
        const next = polls.shift();
        if (!next) throw new Error("polled after GitHub had answered");
        return Response.json(next);
      }
      case `${WORKER}/auth/me`:
        assert.match(request.headers.get("authorization") ?? "", /^Bearer ghu_/);
        return me();
      default:
        throw new Error(`fetched ${request.url}`);
    }
  });
  const run = () =>
    login({
      base: WORKER,
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      },
      say: (line) => said.push(line),
    });
  return { run, asked, waited, said };
}

test("a member's sign-in is kept, readable by them alone, once the Worker accepts it", async (t) => {
  const { run, waited, said } = device(
    t,
    [
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { error: "authorization_pending" },
      { access_token: "ghu_ada", expires_in: 28800 },
    ],
    () => Response.json({ login: "ada" }),
  );
  const signedIn = await run();
  assert.deepEqual(said, ["Open https://github.com/login/device and enter WDJB-MJHT"]);
  // Five seconds as GitHub asked, then ten once it asked for slower.
  assert.deepEqual(waited, [5000, 5000, 10000, 10000]);
  assert.deepEqual(signedIn, {
    token: "ghu_ada",
    login: "ada",
    expiresAt: new Date(START + 30_000 + 28_800_000).toISOString(),
  });
  assert.deepEqual(readLogin(), signedIn);
  assert.equal(statSync(loginPath()).mode & 0o777, 0o600);
  assert.equal(bearerFor(WORKER, START + 60_000), "ghu_ada");
});

test("a sign-in the Worker refuses is reported and not kept", async (t) => {
  const { run } = device(t, [{ access_token: "ghu_eve" }], () =>
    Response.json({ error: "eve is not in origin89hq/working-group" }, { status: 403 }),
  );
  await assert.rejects(run(), /refused: eve is not in origin89hq\/working-group/);
  assert.equal(readLogin(), undefined);
});

test("a code that expires, or a sign-in declined on GitHub, ends with the reason", async (t) => {
  const expired = device(t, [{ error: "expired_token" }], () => Response.json({}));
  await assert.rejects(expired.run(), /the code expired/);
  const declined = device(t, [{ error: "access_denied" }], () => Response.json({}));
  await assert.rejects(declined.run(), /declined on GitHub/);
  assert.equal(readLogin(), undefined);
});

test("nobody entering the code stops at GitHub's deadline rather than polling forever", async (t) => {
  const pending = Array.from({ length: 500 }, () => ({ error: "authorization_pending" }));
  const { run, waited } = device(t, pending, () => Response.json({}));
  await assert.rejects(run(), /the code expired before it was entered/);
  // 900 seconds at 5 a poll.
  assert.equal(waited.length, 180);
});

test("an app without device flow turned on is reported in GitHub's words", async (t) => {
  isolated(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    String(input) === `${WORKER}/auth/app`
      ? Response.json({ clientId: "Iv23test", org: "origin89hq", team: "working-group" })
      : Response.json(
          {
            error: "device_flow_disabled",
            error_description: "Device Flow must be explicitly enabled for this App",
          },
          { status: 400 },
        ),
  );
  await assert.rejects(
    login({ base: WORKER, say: () => {} }),
    /GitHub answered 400: Device Flow must be explicitly enabled for this App/,
  );
});

test("a Worker without sign-in configured says so before anybody is sent to GitHub", async (t) => {
  isolated(t);
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return Response.json(
      { error: "GitHub sign-in is not configured on this Worker" },
      { status: 503 },
    );
  });
  await assert.rejects(login({ base: WORKER, say: () => {} }), /is sign-in configured there\?/);
  assert.deepEqual(asked, [`${WORKER}/auth/app`]);
});

test("a deployment gets the stored sign-in until it expires, then is told to sign in again", (t) => {
  isolated(t);
  assert.throws(() => bearerFor(WORKER), /sign in with: just login/);
  saveLogin({ token: "ghu_ada", login: "ada", expiresAt: new Date(START + 1000).toISOString() });
  assert.equal(bearerFor(WORKER, START), "ghu_ada");
  assert.throws(
    () => bearerFor(WORKER, START + 1000),
    /sign-in for ada has expired; run: just login/,
  );
});

test("OFFGRID_CONTROL_TOKEN, where a job still sets it, comes before the stored sign-in", (t) => {
  isolated(t);
  saveLogin({ token: "ghu_ada", login: "ada", expiresAt: new Date(START + 1000).toISOString() });
  process.env.OFFGRID_CONTROL_TOKEN = "the-shared-token";
  assert.equal(bearerFor(WORKER, START), "the-shared-token");
});

test("a stored file that is not a sign-in is an error, never an empty token", (t) => {
  isolated(t);
  mkdirSync(dirname(loginPath()), { recursive: true });
  writeFileSync(loginPath(), JSON.stringify({ token: "" }));
  assert.throws(() => bearerFor(WORKER), /is not a sign-in; run just login/);
});

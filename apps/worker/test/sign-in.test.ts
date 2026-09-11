import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { APPROVAL_EVENT } from "@origin89/equipment-schema/documents";
import { app } from "../src/routes.ts";
import { landing } from "../src/sign-in.ts";
import { APP, type GitHubWorld, githubApi } from "./github-api.ts";
import { world } from "./world.ts";

// The Worker remembers answers about a token for five minutes, across requests and so across
// tests in this file. Every test uses tokens of its own.

const ORIGIN = "https://data.example";

/**
 * The Worker with sign-in configured, in front of the GitHub `github` describes. `allowance` is
 * how many new questions to GitHub each address may cause before the ration runs out.
 */
function signingIn(t: TestContext, github: GitHubWorld = {}, allowance = Number.POSITIVE_INFINITY) {
  const api = githubApi(github);
  t.mock.method(globalThis, "fetch", api.fetch);
  const approvals: { id: string; event: unknown }[] = [];
  const spent = new Map<string, number>();
  const env = {
    ...world().env,
    SIGN_IN_CHECKS: {
      limit: async ({ key }: { key: string }) => {
        spent.set(key, (spent.get(key) ?? 0) + 1);
        return { success: (spent.get(key) ?? 0) <= allowance };
      },
    },
    GITHUB_CLIENT_ID: APP.clientId,
    GITHUB_CLIENT_SECRET: APP.clientSecret,
    CONTROL_TOKEN: "local-control-token",
    SITE: {
      fetch: async (request: Request) =>
        new Response(`the page at ${new URL(request.url).pathname}`),
    },
    MANUFACTURER_CRAWL: {
      get: async (id: string) => ({
        sendEvent: async (event: unknown) => void approvals.push({ id, event }),
      }),
    },
  } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`${ORIGIN}${path}`, init, env);
  return { api, request, approvals, spent, env };
}

/** Each Set-Cookie line of a response, by cookie name. */
function setCookies(res: Response): Map<string, string> {
  return new Map(
    res.headers.getSetCookie().map((line) => [line.slice(0, line.indexOf("=")), line]),
  );
}

/** Start a sign-in, and return what GitHub would be told and what the browser would keep. */
async function start(request: ReturnType<typeof signingIn>["request"], next = "/ops") {
  const res = await request(`/auth/login?next=${encodeURIComponent(next)}`);
  const line = setCookies(res).get("__Host-offgrid-sign-in") ?? "";
  return {
    res,
    state: new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "",
    cookie: line.slice(0, line.indexOf(";")),
  };
}

const approve = (auth: Record<string, string>) => ({
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ approved: true, approvedBy: "somebody typed this", limit: 3 }),
});

test("signing in goes to GitHub with this app, this callback, and a state bound to the browser", async (t) => {
  const { request, api } = signingIn(t);
  const { res, state } = await start(request);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location") ?? "");
  assert.equal(`${to.origin}${to.pathname}`, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), APP.clientId);
  assert.equal(to.searchParams.get("redirect_uri"), "https://data.example/auth/callback");
  assert.match(state, /^[0-9a-f-]{36}$/);
  const cookie = setCookies(res).get("__Host-offgrid-sign-in") ?? "";
  assert.ok(cookie.startsWith(`__Host-offgrid-sign-in=${state}%7C%2Fops;`), cookie);
  for (const flag of ["Max-Age=600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
    assert.ok(cookie.includes(flag), `the sign-in cookie lacks ${flag}: ${cookie}`);
  assert.deepEqual(api.calls, [], "starting a sign-in needs nothing from GitHub");
});

test("a member back from GitHub gets a session cookie and lands where they were going", async (t) => {
  const { request } = signingIn(t, {
    codes: { "code-ada": { token: "ghu_ada_callback" } },
    tokens: { ghu_ada_callback: { login: "ada" } },
    team: { ada: "active" },
  });
  const { state, cookie } = await start(request);
  const res = await request(`/auth/callback?code=code-ada&state=${state}`, {
    headers: { cookie },
  });
  assert.equal(res.status, 302, await res.clone().text());
  assert.equal(res.headers.get("location"), "/ops");
  const session = setCookies(res).get("__Host-offgrid-session") ?? "";
  assert.ok(session.startsWith("__Host-offgrid-session=ghu_ada_callback;"), session);
  for (const flag of ["Max-Age=28800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
    assert.ok(session.includes(flag), `the session cookie lacks ${flag}: ${session}`);
  assert.match(setCookies(res).get("__Host-offgrid-sign-in") ?? "", /Max-Age=0/);

  const me = await request("/auth/me", {
    headers: { cookie: "__Host-offgrid-session=ghu_ada_callback" },
  });
  assert.deepEqual(await me.json(), { login: "ada" });
});

test("a callback that did not start in this browser is refused before GitHub is asked", async (t) => {
  const { request, api } = signingIn(t, { codes: { "code-ada": { token: "ghu_ada_forged" } } });
  const { state, cookie } = await start(request);
  for (const [query, headers] of [
    [`code=code-ada&state=${state}x`, { cookie }],
    [`code=code-ada&state=${state}`, {}],
    ["code=code-ada", { cookie }],
  ] as const) {
    const res = await request(`/auth/callback?${query}`, { headers });
    assert.equal(res.status, 400, `${query} answered ${res.status}`);
    assert.equal(setCookies(res).has("__Host-offgrid-session"), false);
  }
  assert.deepEqual(api.calls, []);
});

test("a landing path with a bar in it survives the round trip whole", async (t) => {
  const { request } = signingIn(t, {
    codes: { "code-bar": { token: "ghu_ada_bar" } },
    tokens: { ghu_ada_bar: { login: "ada" } },
    team: { ada: "active" },
  });
  const { state, cookie } = await start(request, "/ops?panel=a|b");
  const res = await request(`/auth/callback?code=code-bar&state=${state}`, { headers: { cookie } });
  assert.equal(res.headers.get("location"), "/ops?panel=a|b");
});

test("somebody not on the team is told why, and gets no session", async (t) => {
  const { request } = signingIn(t, {
    codes: { "code-eve": { token: "ghu_eve_callback" } },
    tokens: { ghu_eve_callback: { login: "eve" } },
    team: {},
  });
  const { state, cookie } = await start(request);
  const res = await request(`/auth/callback?code=code-eve&state=${state}`, { headers: { cookie } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /eve is not in origin89hq\/working-group/);
  assert.equal(setCookies(res).has("__Host-offgrid-session"), false);
});

test("a code GitHub will not exchange is refused with GitHub's reason", async (t) => {
  const { request } = signingIn(t, { codes: {} });
  const { state, cookie } = await start(request);
  const res = await request(`/auth/callback?code=spent&state=${state}`, { headers: { cookie } });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /The code passed is incorrect or expired/);
});

test("signing in lands on this site and nowhere else", () => {
  assert.equal(landing("/ops"), "/ops");
  assert.equal(landing("/ops?panel=makers"), "/ops?panel=makers");
  for (const away of [
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "ops",
    undefined,
  ])
    assert.equal(landing(away), "/", `${away} was allowed`);
});

test("a member's terminal token opens the control routes, and an approval records their login", async (t) => {
  const { request, approvals } = signingIn(t, {
    tokens: { ghu_ada_terminal: { login: "ada" } },
    team: { ada: "active" },
  });
  const res = await request(
    "/approve?id=maker-victron-energy-2026-09-10-abcd",
    approve({ authorization: "Bearer ghu_ada_terminal" }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(approvals, [
    {
      id: "maker-victron-energy-2026-09-10-abcd",
      event: {
        type: APPROVAL_EVENT,
        payload: { approved: true, approvedBy: "ada", hosts: [], limit: 3 },
      },
    },
  ]);
});

test("the control token still works where it is set, and approves as itself", async (t) => {
  const { approvals, api, env } = signingIn(t);
  // Only on this machine: `just dev` is where the control token lives.
  const res = await app.request(
    "http://localhost:8790/approve?id=maker-x",
    approve({ authorization: "Bearer local-control-token" }),
    env,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(approvals, [
    {
      id: "maker-x",
      event: {
        type: APPROVAL_EVENT,
        payload: { approved: true, approvedBy: "the control token", hosts: [], limit: 3 },
      },
    },
  ]);
  assert.deepEqual(api.calls, [], "the control token needs nothing from GitHub");
});

test("a non-member, another app's token, and no token are refused, each for its reason", async (t) => {
  const { request } = signingIn(t, {
    tokens: {
      ghu_eve_terminal: { login: "eve" },
      ghu_ada_other_app: { login: "ada", clientId: "Iv23another-app" },
    },
    team: { ada: "active" },
  });
  const state = (auth: Record<string, string>) => request("/state", { headers: auth });
  const nonMember = await state({ authorization: "Bearer ghu_eve_terminal" });
  assert.equal(nonMember.status, 403);
  const otherApp = await state({ authorization: "Bearer ghu_ada_other_app" });
  assert.equal(otherApp.status, 401);
  const nobody = await state({});
  assert.equal(nobody.status, 401);
  assert.match(((await nobody.json()) as { error: string }).error, /just login/);
});

test("a signed-in browser may read, and may change something only from this site", async (t) => {
  const { request, approvals } = signingIn(t, {
    tokens: { ghu_ada_browser: { login: "ada" } },
    team: { ada: "active" },
  });
  const cookie = "__Host-offgrid-session=ghu_ada_browser";
  assert.equal((await request("/state", { headers: { cookie } })).status, 200);
  for (const origin of [undefined, "https://evil.example"]) {
    const res = await request(
      "/approve?id=maker-x",
      approve({ cookie, ...(origin ? { origin } : {}) }),
    );
    assert.equal(res.status, 403, `a change from ${origin ?? "no origin"} was let through`);
  }
  assert.deepEqual(approvals, []);
  const here = await request("/approve?id=maker-x", approve({ cookie, origin: ORIGIN }));
  assert.equal(here.status, 200);
  assert.equal(approvals.length, 1);
});

test("a second request with the same token makes no call to GitHub", async (t) => {
  const { request, api } = signingIn(t, {
    tokens: { ghu_ada_twice: { login: "ada" } },
    team: { ada: "active" },
  });
  const me = () => request("/auth/me", { headers: { authorization: "Bearer ghu_ada_twice" } });
  assert.equal((await me()).status, 200);
  assert.equal(api.calls.length, 2);
  assert.equal((await me()).status, 200);
  assert.equal(api.calls.length, 2);
});

test("GitHub failing refuses with 502 rather than letting anybody in", async (t) => {
  const { request } = signingIn(t, { down: 503 });
  const res = await request("/state", { headers: { authorization: "Bearer ghu_while_down" } });
  assert.equal(res.status, 502);
});

test("signing out clears the session, and only from this site", async (t) => {
  const { request } = signingIn(t);
  const cookie = "__Host-offgrid-session=ghu_anything";
  assert.equal(
    (await request("/auth/logout", { method: "POST", headers: { cookie } })).status,
    403,
  );
  const res = await request("/auth/logout", {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(res.status, 303);
  assert.match(setCookies(res).get("__Host-offgrid-session") ?? "", /Max-Age=0/);
});

test("the device flow learns the app from the Worker, and a Worker without one says so", async (t) => {
  const { request } = signingIn(t);
  assert.deepEqual(await (await request("/auth/app")).json(), {
    clientId: APP.clientId,
    org: "origin89hq",
    team: "working-group",
  });
  const bare = await app.request(`${ORIGIN}/auth/app`, {}, world().env);
  assert.equal(bare.status, 503);
});

test("the runs page is for members: others are sent to sign in, or told why not", async (t) => {
  const { request } = signingIn(t, {
    tokens: { ghu_ada_ops: { login: "ada" }, ghu_eve_ops: { login: "eve" } },
    team: { ada: "active" },
  });
  const anonymous = await request("/ops");
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), "/auth/login?next=%2Fops");

  const outsider = await request("/ops", {
    headers: { cookie: "__Host-offgrid-session=ghu_eve_ops" },
  });
  assert.equal(outsider.status, 403);
  assert.match(await outsider.text(), /eve is not in origin89hq\/working-group/);

  const member = await request("/ops", {
    headers: { cookie: "__Host-offgrid-session=ghu_ada_ops" },
  });
  assert.equal(member.status, 200);
  assert.equal(await member.text(), "the page at /ops");
  assert.equal(member.headers.get("cache-control"), "private, no-store");
});

test("an address sending made-up tokens is rationed, and a member elsewhere is not", async (t) => {
  const { request, api, spent } = signingIn(
    t,
    { tokens: { ghu_ada_elsewhere: { login: "ada" } }, team: { ada: "active" } },
    3,
  );
  const from = (address: string, token: string) =>
    request("/state", {
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": address },
    });
  for (let i = 0; i < 3; i += 1)
    assert.equal((await from("203.0.113.9", `ghu_junk_${i}`)).status, 401);
  const asked = api.calls.length;
  const cut = await from("203.0.113.9", "ghu_junk_3");
  assert.equal(cut.status, 429);
  assert.equal(api.calls.length, asked, "GitHub was asked past the ration");
  assert.equal((await from("198.51.100.4", "ghu_ada_elsewhere")).status, 200);
  assert.deepEqual([...spent.keys()].sort(), ["198.51.100.4", "203.0.113.9"]);
});

test("a sign-in past the ration stops before the code is exchanged", async (t) => {
  const { request, api } = signingIn(t, { codes: { "code-ada": { token: "ghu_ada_late" } } }, 0);
  const { state, cookie } = await start(request);
  const res = await request(`/auth/callback?code=code-ada&state=${state}`, { headers: { cookie } });
  assert.equal(res.status, 429);
  assert.deepEqual(api.calls, [], "the code was exchanged past the ration");
});

test("dashboard deep links preserve the login destination and serve the protected shell", async (t) => {
  const { request } = signingIn(t, {
    codes: { "code-deep": { token: "ghu_ada_deep" } },
    tokens: { ghu_ada_deep: { login: "ada" }, ghu_eve_deep: { login: "eve" } },
    team: { ada: "active" },
  });
  for (const path of [
    "/ops/makers?filter=review&q=Rolls",
    "/ops/releases",
    "/ops/not-a-section",
    "/ops/",
  ]) {
    const anonymous = await request(path);
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), `/auth/login?next=${encodeURIComponent(path)}`);
    const outsider = await request(path, {
      headers: { cookie: "__Host-offgrid-session=ghu_eve_deep" },
    });
    assert.equal(outsider.status, 403);
    const member = await request(path, {
      headers: { cookie: "__Host-offgrid-session=ghu_ada_deep" },
    });
    assert.equal(member.status, 200);
    assert.equal(await member.text(), "the page at /ops");
    assert.equal(member.headers.get("cache-control"), "private, no-store");
  }
  const { state, cookie } = await start(request, "/ops/makers?filter=review");
  const callback = await request(`/auth/callback?state=${state}&code=code-deep`, {
    headers: { cookie },
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/ops/makers?filter=review");
});

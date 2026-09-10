import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { GitHubUnavailable, MEMBERSHIP_TTL_MS, Memberships } from "../src/members.ts";
import { APP, type GitHubWorld, githubApi } from "./github-api.ts";

/** A membership checker on a clock the test moves, talking to the GitHub `world` describes. */
function checking(t: TestContext, world: GitHubWorld) {
  const github = githubApi(world);
  t.mock.method(globalThis, "fetch", github.fetch);
  let now = Date.parse("2026-09-10T12:00:00Z");
  const members = new Memberships(() => now);
  return {
    github,
    check: (token: string) => members.check(token, APP),
    wait: (ms: number) => {
      now += ms;
    },
  };
}

test("an active member of the team is let in, by the login GitHub vouches for", async (t) => {
  const { github, check } = checking(t, {
    tokens: { ghu_ada: { login: "ada" } },
    team: { ada: "active" },
  });
  assert.deepEqual(await check("ghu_ada"), { ok: true, login: "ada" });
  assert.deepEqual(
    github.calls.map((call) => `${call.method} ${call.url}`),
    [
      `POST https://api.github.com/applications/${APP.clientId}/token`,
      "GET https://api.github.com/orgs/origin89hq/teams/working-group/memberships/ada",
    ],
  );
  // The token check is the app's own credentials; the team check is the person's token.
  assert.equal(
    github.calls[0].authorization,
    `Basic ${btoa(`${APP.clientId}:${APP.clientSecret}`)}`,
  );
  assert.equal(github.calls[1].authorization, "Bearer ghu_ada");
  assert.ok(
    github.calls.every((call) => call.agent),
    "GitHub refuses a request with no user agent",
  );
});

test("somebody GitHub knows who is not on the team is refused as forbidden", async (t) => {
  const { check } = checking(t, { tokens: { ghu_eve: { login: "eve" } }, team: {} });
  assert.deepEqual(await check("ghu_eve"), {
    ok: false,
    status: 403,
    reason: "eve is not in origin89hq/working-group",
  });
});

test("an invitation not yet accepted is not membership", async (t) => {
  const { check } = checking(t, {
    tokens: { ghu_bob: { login: "bob" } },
    team: { bob: "pending" },
  });
  assert.deepEqual(await check("ghu_bob"), {
    ok: false,
    status: 403,
    reason: "bob's membership of origin89hq/working-group is pending",
  });
});

test("a member's token from another GitHub App is refused before the team is asked", async (t) => {
  const { github, check } = checking(t, {
    tokens: { ghu_other_app: { login: "ada", clientId: "Iv23another-app" } },
    team: { ada: "active" },
  });
  assert.deepEqual(await check("ghu_other_app"), {
    ok: false,
    status: 401,
    reason: "not a token from this app, or it has expired",
  });
  assert.equal(github.calls.length, 1, "the team was asked about a token this app did not issue");
});

test("gh's own token, or any string that is not an app user token, costs no call to GitHub", async (t) => {
  const { github, check } = checking(t, { team: { ada: "active" } });
  for (const token of [
    "gho_16C7e42F292c6912E7710c838347Ae178B4a",
    "ghp_personal",
    "the-control-token",
  ])
    assert.deepEqual(await check(token), {
      ok: false,
      status: 401,
      reason: "not a GitHub App user token",
    });
  assert.deepEqual(github.calls, []);
});

test("an expired token is refused, whether GitHub forgets it or reports it expired", async (t) => {
  const { check } = checking(t, {
    tokens: { ghu_stale: { login: "ada", expiresAt: "2026-09-10T11:59:59Z" } },
    team: { ada: "active" },
  });
  assert.deepEqual(await check("ghu_stale"), {
    ok: false,
    status: 401,
    reason: "the token has expired; sign in again",
  });
  assert.deepEqual(await check("ghu_forgotten"), {
    ok: false,
    status: 401,
    reason: "not a token from this app, or it has expired",
  });
});

test("a remembered answer makes no call to GitHub, and a removal lands within five minutes", async (t) => {
  const world: GitHubWorld = { tokens: { ghu_ada: { login: "ada" } }, team: { ada: "active" } };
  const { github, check, wait } = checking(t, world);
  assert.equal((await check("ghu_ada")).ok, true);
  const asked = github.calls.length;
  wait(MEMBERSHIP_TTL_MS - 1);
  assert.equal((await check("ghu_ada")).ok, true);
  assert.equal(github.calls.length, asked, "a remembered answer asked GitHub again");
  // Taken off the team. The answer already given stands until it is five minutes old, and no longer.
  world.team = {};
  wait(1);
  assert.equal((await check("ghu_ada")).ok, false);
  assert.equal(github.calls.length, asked + 2);
});

test("GitHub failing is an error, not a refusal, and is not remembered", async (t) => {
  const world: GitHubWorld = {
    tokens: { ghu_ada: { login: "ada" } },
    team: { ada: "active" },
    down: 503,
  };
  const { check } = checking(t, world);
  await assert.rejects(check("ghu_ada"), GitHubUnavailable);
  world.down = undefined;
  assert.deepEqual(await check("ghu_ada"), { ok: true, login: "ada" });
});

test("a wrong client secret is the Worker's fault, reported as GitHub being unusable", async (t) => {
  checking(t, { tokens: { ghu_ada: { login: "ada" } }, team: { ada: "active" } });
  const members = new Memberships();
  await assert.rejects(
    members.check("ghu_ada", { ...APP, clientSecret: "rotated-away" }),
    /GitHub's token check answered 401/,
  );
});

test("GitHub not answering at all is reported, not thrown past the caller", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    new Memberships().check("ghu_ada", APP),
    /GitHub did not answer: fetch failed/,
  );
});

test("a remembered success ends when its token does, not five minutes later", async (t) => {
  // Two minutes of life left when first checked.
  const { github, check, wait } = checking(t, {
    tokens: { ghu_ending: { login: "ada", expiresAt: "2026-09-10T12:02:00Z" } },
    team: { ada: "active" },
  });
  assert.equal((await check("ghu_ending")).ok, true);
  const asked = github.calls.length;
  wait(2 * 60_000 - 1);
  assert.equal((await check("ghu_ending")).ok, true, "forgot a success before the token ended");
  assert.equal(github.calls.length, asked);
  wait(1);
  assert.deepEqual(await check("ghu_ending"), {
    ok: false,
    status: 401,
    reason: "the token has expired; sign in again",
  });
});

test("made-up tokens cannot push a member's remembered answer out", async (t) => {
  const { github, check } = checking(t, {
    tokens: { ghu_ada_kept: { login: "ada" } },
    team: { ada: "active" },
  });
  assert.equal((await check("ghu_ada_kept")).ok, true);
  for (let i = 0; i <= 1000; i += 1) await check(`ghu_made_up_${i}`);
  const asked = github.calls.length;
  assert.equal((await check("ghu_ada_kept")).ok, true);
  assert.equal(github.calls.length, asked, "the member's answer was pushed out by refusals");
});

test("past its ration a caller is refused without GitHub being asked, and remembered answers stand", async (t) => {
  const github = githubApi({
    tokens: { ghu_ada_rationed: { login: "ada" } },
    team: { ada: "active" },
  });
  t.mock.method(globalThis, "fetch", github.fetch);
  const members = new Memberships();
  const allowed = async () => true;
  const spent = async () => false;
  assert.equal((await members.check("ghu_ada_rationed", APP, allowed)).ok, true);
  const asked = github.calls.length;
  assert.deepEqual(await members.check("ghu_never_seen", APP, spent), {
    ok: false,
    status: 429,
    reason: "too many sign-in checks from here; wait a minute",
  });
  assert.equal((await members.check("ghu_ada_rationed", APP, spent)).ok, true);
  assert.equal(github.calls.length, asked, "GitHub was asked past the ration");
});

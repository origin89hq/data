import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createLocalJWKSet, createRemoteJWKSet, generateKeyPair, UnsecuredJWT } from "jose";
import {
  AUDIENCE,
  admits,
  GITHUB_ISSUER,
  GitHubKeysUnavailable,
  PRODUCTION,
  verifyJob,
  verifyWorkflow,
  type WorkflowRule,
} from "../src/oidc.ts";
import { app } from "../src/routes.ts";
import { jobToken, jwks, publishJob } from "./github-token.ts";
import { world } from "./world.ts";

const keys = createLocalJWKSet(jwks);
/** What the publish route takes. */
const PUBLISH: WorkflowRule = {
  workflow: "publish.yml",
  events: ["push", "workflow_dispatch"],
  environment: PRODUCTION,
};
const verify = (token: string, rule = PUBLISH) => verifyWorkflow(token, rule, keys);

/** Refused, with a reason that names what was wrong. */
async function refused(token: string, reason: RegExp, rule?: WorkflowRule) {
  const check = await verify(token, rule);
  assert.equal(check.ok, false, "the token was accepted");
  if (!check.ok) assert.match(check.reason, reason);
}

test("a token from publish.yml on main, pushed or dispatched, is accepted", async () => {
  const pushed = await verify(await jobToken());
  assert.deepEqual(pushed, {
    ok: true,
    job: {
      workflow: "publish.yml",
      event: "push",
      environment: PRODUCTION,
      runId: publishJob.run_id,
      sha: publishJob.sha,
    },
  });
  const dispatched = await verify(await jobToken({ event_name: "workflow_dispatch" }));
  assert.equal(dispatched.ok, true);
});

test("a token GitHub did not issue, or issued for another service, is refused", async () => {
  await refused(await jobToken({}, { issuer: "https://token.example" }), /"iss"/);
  await refused(await jobToken({}, { audience: "sts.amazonaws.com" }), /"aud"/);
  await refused(await jobToken({}, { audience: `${AUDIENCE}.evil.example` }), /"aud"/);
});

test("an expired token is refused, and one inside the clock tolerance is not", async () => {
  await refused(await jobToken({}, { expiresIn: -120 }), /"exp"/);
  assert.equal((await verify(await jobToken({}, { expiresIn: -10 }))).ok, true);
});

test("a token from another repository or owner is refused, whatever it is named", async () => {
  // Same name, different id: the repository was deleted and recreated, or renamed and replaced.
  await refused(await jobToken({ repository_id: "1" }), /repository_id is 1/);
  await refused(await jobToken({ repository_owner_id: "2" }), /repository_owner_id is 2/);
});

test("a token from another branch, or a tag, is refused", async () => {
  await refused(await jobToken({ ref: "refs/heads/feature" }), /ref is refs\/heads\/feature/);
  await refused(await jobToken({ ref: "refs/tags/v1" }), /ref is refs\/tags\/v1/);
  await refused(
    await jobToken({
      workflow_ref: "origin89hq/offgrid-equipment/.github/workflows/publish.yml@refs/heads/feature",
    }),
    /workflow_ref/,
  );
});

test("a token from another workflow file is refused, including one this route does not name", async () => {
  await refused(
    await jobToken({
      workflow_ref: "origin89hq/offgrid-equipment/.github/workflows/check.yml@refs/heads/main",
    }),
    /the token is from check\.yml; this route takes publish\.yml/,
  );
  // The publish job's token is not good on a route that names some other workflow.
  await refused(await jobToken(), /this route takes deploy\.yml/, {
    ...PUBLISH,
    workflow: "deploy.yml",
  });
});

test("a pull request's token is refused even when every other claim matches", async () => {
  await refused(await jobToken({ event_name: "pull_request" }), /started by pull_request/);
  await refused(await jobToken({ event_name: "pull_request_target" }), /pull_request_target/);
});

test("a job outside the production environment is refused", async () => {
  await refused(await jobToken({ environment: undefined }), /environment is absent/);
  await refused(await jobToken({ environment: "staging" }), /environment is staging/);
});

test("a key GitHub never published is refused, under its own id or under GitHub's", async () => {
  const other = (await generateKeyPair("RS256")).privateKey;
  await refused(await jobToken({}, { key: other, kid: "not-published" }), /no applicable key/i);
  await refused(await jobToken({}, { key: other }), /signature verification failed/);
});

test("an unsigned token is refused, however right its claims", async () => {
  const unsigned = new UnsecuredJWT({ ...publishJob })
    .setIssuer(GITHUB_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime("5m")
    .encode();
  assert.match(unsigned, /\.$/, "an unsigned JWT has an empty signature");
  await refused(unsigned, /"alg" \(Algorithm\) Header Parameter value not allowed/);
});

test("a token that is not a JWT is refused rather than thrown", async () => {
  await refused("not-a-token", /Invalid Compact JWS/);
  await refused("", /Invalid Compact JWS/);
});

test("a key set GitHub cannot serve is an outage, not a refusal of the token", async (t) => {
  const token = await jobToken();
  let respond: (init?: RequestInit) => Promise<Response> = async () => Response.json(jwks);
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => respond(init));
  const cases: [string, (init?: RequestInit) => Promise<Response>][] = [
    ["a 500", async () => new Response("down", { status: 500 })],
    ["not JSON", async () => new Response("<html>")],
    ["not a key set", async () => Response.json({ keys: "none" })],
    [
      "no connection",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "no answer in time",
      (init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    ],
  ];
  for (const [what, answer] of cases) {
    respond = answer;
    const keys = createRemoteJWKSet(new URL("https://keys.example/jwks"), { timeoutDuration: 20 });
    await assert.rejects(
      verifyWorkflow(token, PUBLISH, keys),
      GitHubKeysUnavailable,
      `${what} was answered as though the token were bad`,
    );
  }
});

test("publishing while GitHub's keys cannot be read answers 503 and writes nothing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("down", { status: 502 }));
  const archive = world();
  const res = await app.request(
    "https://data.example/v1/models.csv",
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await jobToken()}`,
        "x-content-sha256": createHash("sha256").update("abc").digest("hex"),
        "content-length": "3",
      },
      body: "abc",
    },
    archive.env,
  );
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /signing keys could not be read/);
  assert.deepEqual([...archive.store.keys()], []);
});

test("a job is any workflow on main here; which ones a route takes is the route's rule", async () => {
  const pull = await jobToken({
    workflow_ref: "origin89hq/offgrid-equipment/.github/workflows/pull-figures.yml@refs/heads/main",
    event_name: "schedule",
    environment: undefined,
  });
  const checked = await verifyJob(pull, keys);
  assert.deepEqual(checked, {
    ok: true,
    job: {
      workflow: "pull-figures.yml",
      event: "schedule",
      runId: publishJob.run_id,
      sha: publishJob.sha,
    },
  });
  if (!checked.ok) return;
  const daily: WorkflowRule = {
    workflow: "pull-figures.yml",
    events: ["schedule", "workflow_dispatch"],
  };
  assert.deepEqual(admits(daily, checked.job), { ok: true });
  // A rule with no environment does not care whether the job has one.
  assert.deepEqual(admits(daily, { ...checked.job, environment: PRODUCTION }), { ok: true });
  assert.deepEqual(admits({ ...daily, events: ["workflow_dispatch"] }, checked.job), {
    ok: false,
    reason: "pull-figures.yml was started by schedule; this route takes workflow_dispatch",
  });
  assert.equal(admits(PUBLISH, checked.job).ok, false);
});

test("a workflow path that leaves the workflows directory is not a workflow of this repository", async () => {
  for (const workflow_ref of [
    "origin89hq/offgrid-equipment/.github/workflows/../../evil.yml@refs/heads/main",
    "origin89hq/offgrid-equipment/.github/workflows/nested/publish.yml@refs/heads/main",
    "origin89hq/offgrid-equipment-fork/.github/workflows/publish.yml@refs/heads/main",
    "origin89hq/offgrid-equipment/.github/workflows/publish.yml@refs/heads/main2",
  ]) {
    const checked = await verifyJob(await jobToken({ workflow_ref }), keys);
    assert.equal(checked.ok, false, `${workflow_ref} was taken`);
  }
});

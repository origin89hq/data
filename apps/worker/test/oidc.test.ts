import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, generateKeyPair, UnsecuredJWT } from "jose";
import { AUDIENCE, GITHUB_ISSUER, verifyWorkflow } from "../src/oidc.ts";
import { jobToken, jwks, publishJob } from "./github-token.ts";

const keys = createLocalJWKSet(jwks);
const verify = (token: string, workflow = "publish.yml") => verifyWorkflow(token, workflow, keys);

/** Refused, with a reason that names what was wrong. */
async function refused(token: string, reason: RegExp, workflow?: string) {
  const check = await verify(token, workflow);
  assert.equal(check.ok, false, "the token was accepted");
  if (!check.ok) assert.match(check.reason, reason);
}

test("a token from publish.yml on main, pushed or dispatched, is accepted", async () => {
  const pushed = await verify(await jobToken());
  assert.deepEqual(pushed, {
    ok: true,
    run: { workflowRef: publishJob.workflow_ref, runId: publishJob.run_id, sha: publishJob.sha },
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
    /workflow_ref is .*check\.yml/,
  );
  // The publish job's token is not good on a route that names some other workflow.
  await refused(await jobToken(), /this route needs .*deploy\.yml/, "deploy.yml");
});

test("a pull request's token is refused even when every other claim matches", async () => {
  await refused(await jobToken({ event_name: "pull_request" }), /event_name is pull_request/);
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

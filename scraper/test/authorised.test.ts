import { test } from "node:test";
import assert from "node:assert/strict";
import { authorised, bearer, sameSecret } from "../src/authorised.ts";
import { LOGO_PATH } from "../src/runs.ts";

const req = (header?: string) => new Request("https://x.test/run", { method: "POST", headers: header ? { authorization: header } : {} });

test("a deployment with no token refuses everything, rather than allowing everything", async () => {
  assert.equal(await authorised(req("Bearer anything"), undefined), false);
  assert.equal(await authorised(req("Bearer anything"), ""), false);
});

test("only the right token is accepted, and a prefix of it is not", async () => {
  assert.equal(await authorised(req("Bearer s3cret"), "s3cret"), true);
  assert.equal(await authorised(req("Bearer s3cre"), "s3cret"), false);
  assert.equal(await authorised(req("Bearer s3cretx"), "s3cret"), false);
  assert.equal(await authorised(req("Bearer S3CRET"), "s3cret"), false);
});

test("a request with no token, or a scheme that is not Bearer, does not act", async () => {
  assert.equal(await authorised(req(), "s3cret"), false);
  assert.equal(await authorised(req("s3cret"), "s3cret"), false);
  assert.equal(await authorised(req("Basic s3cret"), "s3cret"), false);
});

test("the token is read case-insensitively off the scheme and trimmed of surrounding space", () => {
  assert.equal(bearer(req("bearer abc")), "abc");
  assert.equal(bearer(req("  Bearer   abc  ")), "abc");
  assert.equal(bearer(req()), undefined);
});

test("the comparison does not short-circuit on the first differing byte", async () => {
  assert.equal(await sameSecret("aaaaaaaa", "aaaaaaaa"), true);
  assert.equal(await sameSecret("aaaaaaaa", "baaaaaaa"), false);
  assert.equal(await sameSecret("", ""), true);
});

test("a logo is public, and the archive around it is not", () => {
  // A page that renders the catalogue cannot carry the control token, so these keys and only these
  // are readable without one. Anything else under the archive still needs the bearer. The pattern
  // is imported rather than retyped: a copy here would keep passing after the real one changed.
  assert.equal(LOGO_PATH.test("/logos/victron-energy-128.png"), true);
  assert.equal(LOGO_PATH.test("/logos/eg4-electronics-64.png"), true);
  assert.equal(LOGO_PATH.test("/logos/../documents/victron-energy/current.json"), false);
  assert.equal(LOGO_PATH.test("/logos/victron-energy-128.png/../../secret"), false);
  assert.equal(LOGO_PATH.test("/documents/victron-energy/current.json"), false);
  assert.equal(LOGO_PATH.test("/archive/abc.reading.json"), false);
});

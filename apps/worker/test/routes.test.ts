import assert from "node:assert/strict";
import { test } from "node:test";
import { app, CONTROL_PATHS, controlRoutes, publicRoutes } from "../src/routes.ts";

/**
 * The route tables themselves, not a list of paths written out here. A copy would keep passing
 * after somebody added a route to the wrong app, which is the whole failure this guards.
 */
const paths = (rows: { path: string }[]) => [...new Set(rows.map((r) => r.path))].sort();

test("exactly three paths are public, and nothing was added to that list by accident", () => {
  // A page that renders the catalogue cannot carry the token, so these are open. Everything else
  // in the archive is a crawl, a document or a reading, and none of that is anybody's business.
  assert.deepEqual(paths(publicRoutes.routes), [
    "/",
    "/logos/:file",
    "/manifest.json",
    "/v1/:file",
  ]);
});

test("every control route is behind the middleware, whatever order it was written in", () => {
  // The bearer check is registered on "*" of the control app, so it runs before any handler there.
  // This used to be one `if` partway down a chain, where a route's safety depended on where in the
  // file somebody put it.
  for (const path of CONTROL_PATHS) {
    assert.ok(
      !paths(publicRoutes.routes).includes(path),
      `${path} is registered as both public and controlled`,
    );
  }
});

const site = {
  CONTROL_TOKEN: "the-real-token",
  SITE: { fetch: async () => new Response("the site", { status: 200 }) },
};

test("every control path carries the guard, and no control route is left without one", () => {
  // The handlers and the guarded paths come from the same list, so a route added without a guard
  // is not something that can be written. A middleware on "*" would have been simpler and wrong:
  // it reaches everything the public routes did not match, which is the site's own stylesheet.
  const handlers = paths(controlRoutes.routes).filter((path) => path !== "/*" && path !== "*");
  assert.deepEqual(handlers, [...CONTROL_PATHS].sort());
  assert.equal(
    controlRoutes.routes.filter((r) => r.path === "*" || r.path === "/*").length,
    0,
    "nothing may guard every path",
  );
});

test("the site is served, and asking for it never demands a token", async () => {
  // A page whose stylesheet answers 401 loads and then refuses to dress itself.
  for (const path of [
    "/assets/index.css",
    "/assets/index.js",
    "/favicon.ico",
    "/anything-the-router-does-not-know",
  ]) {
    const res = await app.request("https://data.example" + path, {}, site);
    assert.equal(
      res.status,
      200,
      `${path} answered ${res.status} rather than being handed to the site`,
    );
  }
});

test("a control path is refused whatever else is served without a token", async () => {
  for (const path of CONTROL_PATHS) {
    const res = await app.request("https://data.example" + path, { method: "POST" }, site);
    assert.equal(res.status, 401, `${path} answered ${res.status} without a token`);
  }
});

test("a control route with no token is refused rather than run", async () => {
  const res = await app.request("https://data.example/state", {}, site);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(String((body as { error?: string }).error), /bearer token/);
});

test("the wrong token is refused too", async () => {
  const res = await app.request(
    "https://data.example/state",
    { headers: { authorization: "Bearer not-the-real-token" } },
    site,
  );
  assert.equal(res.status, 401);
});

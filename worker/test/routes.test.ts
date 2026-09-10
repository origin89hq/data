import { test } from "node:test";
import assert from "node:assert/strict";
import { app, controlRoutes, publicRoutes } from "../src/routes.ts";

/**
 * The route tables themselves, not a list of paths written out here. A copy would keep passing
 * after somebody added a route to the wrong app, which is the whole failure this guards.
 */
const paths = (rows: { path: string }[]) => [...new Set(rows.map((r) => r.path))].sort();

test("exactly three paths are public, and nothing was added to that list by accident", () => {
  // A page that renders the catalogue cannot carry the token, so these are open. Everything else
  // in the archive is a crawl, a document or a reading, and none of that is anybody's business.
  assert.deepEqual(paths(publicRoutes.routes), ["/", "/logos/:file", "/v1/:file"]);
});

test("every control route is behind the middleware, whatever order it was written in", () => {
  // The bearer check is registered on "*" of the control app, so it runs before any handler there.
  // This used to be one `if` partway down a chain, where a route's safety depended on where in the
  // file somebody put it.
  const guards = controlRoutes.routes.filter((r) => r.path === "/*" || r.path === "*");
  assert.ok(guards.length >= 1, "the control app must carry a middleware that matches every path");
  // Named, so adding one is a deliberate act rather than something that slips in.
  const handlers = paths(controlRoutes.routes).filter((path) => path !== "/*" && path !== "*");
  assert.deepEqual(handlers, [
    "/approve", "/archive", "/classify", "/convert", "/discover-all",
    "/maker", "/run", "/spec-pages", "/state", "/status", "/supervise",
  ]);
  for (const path of handlers) {
    assert.ok(!paths(publicRoutes.routes).includes(path), `${path} is registered as both public and controlled`);
  }
});

test("a path nobody registered falls through to the token, not past it", async () => {
  // The safe direction. A typo in a public path must land on a 401 rather than an open handler.
  for (const path of ["/logos", "/v1", "/logs/x-64.png", "/v1/specs.parquet/../../secret", "/documents/epever/current.json", "/state", "/supervise"]) {
    const res = await app.request("https://data.example" + path, {}, { CONTROL_TOKEN: "a-token-nobody-sent" });
    assert.ok(res.status === 401 || res.status === 404, `${path} answered ${res.status}, which is neither refused nor absent`);
  }
});

test("a control route with no token is refused rather than run", async () => {
  const res = await app.request("https://data.example/state", {}, { CONTROL_TOKEN: "the-real-token" });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(String((body as { error?: string }).error), /bearer token/);
});

test("the wrong token is refused too", async () => {
  const res = await app.request(
    "https://data.example/state",
    { headers: { authorization: "Bearer not-the-real-token" } },
    { CONTROL_TOKEN: "the-real-token" },
  );
  assert.equal(res.status, 401);
});

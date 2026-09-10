import assert from "node:assert/strict";
import { test } from "node:test";
import { READS_PER_REQUEST } from "@origin89/equipment-schema/provenance";
import { app, CONTROL_PATHS, controlRoutes, publicRoutes } from "../src/routes.ts";
import { world } from "./world.ts";

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

const digest = (n: number) => String(n).padStart(64, "0");
const archive = (objects: Record<string, string>) => ({
  ...world(objects).env,
  CONTROL_TOKEN: "the-real-token",
});
const ask = (env: Env, body: unknown) =>
  app.request(
    "https://data.example/readings",
    {
      method: "POST",
      headers: { authorization: "Bearer the-real-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

test("a batch of documents comes back as one reading per line, and an unread one is simply absent", async () => {
  // The failure this replaced: one request per document per reader, which for four thousand
  // documents across three readers is thirteen thousand round trips and half an hour of CI.
  const env = archive({
    [`archive/${digest(1)}.text.reading.json`]: '{"sha256":"one","by":"text"}\n',
    [`archive/${digest(1)}.vision.reading.json`]: '{"sha256":"one","by":"vision"}',
    [`archive/${digest(3)}.text.reading.json`]: '{"sha256":"three","by":"text"}',
  });
  const res = await ask(env, {
    documents: [digest(1), digest(2), digest(3)],
    readers: ["text", "vision"],
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  const lines = (await res.text()).split("\n").filter(Boolean);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { sha256: "one", by: "text" },
      { sha256: "one", by: "vision" },
      { sha256: "three", by: "text" },
    ],
  );
});

test("a reading that already ends in a newline does not become a blank line", async () => {
  // jsonValues on the other end refuses an unbalanced value, so a stray blank line would have
  // stopped a maker's whole pull rather than lost one figure.
  const env = archive({ [`archive/${digest(1)}.text.reading.json`]: '{"a":1}\n\n\n' });
  const res = await ask(env, { documents: [digest(1)], readers: ["text"] });
  assert.equal(await res.text(), '{"a":1}\n');
});

test("a batch bigger than the cap is refused rather than trimmed", async () => {
  // Every reading is a subrequest and a Worker gets a bounded number of them. A stream that runs
  // out partway is a 200 with fewer readings in it, which reads exactly like documents nobody has
  // read yet — the maker would quietly lose figures and nothing would say so.
  const documents = Array.from({ length: READS_PER_REQUEST }, (_, i) => digest(i));
  const res = await ask(archive({}), { documents, readers: ["text", "vision"] });
  assert.equal(res.status, 400);
  assert.match(String(((await res.json()) as { error: string }).error), /more than 2000 reads/);

  const fits = await ask(archive({}), { documents: documents.slice(0, 1000), readers: ["a", "b"] });
  assert.equal(fits.status, 200, "the cap itself must be allowed, not one short of it");
});

test("a document that is not a content address cannot name another key", async () => {
  // The key is built by interpolation, so a value with a slash in it would read anything in the
  // bucket: a run's own pointers, another maker's crawl, the dataset itself.
  for (const documents of [
    ["documents/victron-energy/runs/2026-09-10/converting"],
    [`${digest(1)}.text.reading.json`],
    ["../../dataset/v1/equipment"],
    [42],
  ]) {
    const res = await ask(archive({}), { documents, readers: ["text"] });
    assert.equal(res.status, 400, `${String(documents[0])} was not refused`);
  }
  const reader = await ask(archive({}), { documents: [digest(1)], readers: ["../pointer"] });
  assert.equal(reader.status, 400, "a reader key may not climb out of the key either");
});

test("asking for nothing is refused, so an empty answer is never mistaken for an empty archive", async () => {
  for (const body of [
    {},
    { readers: ["text"] },
    { documents: [digest(1)] },
    { documents: [], readers: ["text"] },
    { documents: [digest(1)], readers: [] },
  ]) {
    const res = await ask(archive({}), body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was answered ${res.status}`);
  }
  const broken = await app.request(
    "https://data.example/readings",
    {
      method: "POST",
      headers: { authorization: "Bearer the-real-token", "content-type": "application/json" },
      body: "{not json",
    },
    archive({}),
  );
  assert.equal(broken.status, 400);
});

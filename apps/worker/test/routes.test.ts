import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { READS_PER_REQUEST } from "@origin89/equipment-schema/provenance";
import { GITHUB_ISSUER } from "../src/oidc.ts";
import {
  app,
  CONTROL_PATHS,
  controlRoutes,
  publicRoutes,
  WORKFLOW_ROUTES,
  workflowRoutes,
} from "../src/routes.ts";
import { jobToken, jwks } from "./github-token.ts";
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

// GitHub's key set, served from here. The Worker fetches it exactly as it would from GitHub.
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
let jwksFetches = 0;
mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== JWKS_URL) throw new Error(`the Worker fetched ${url}`);
  jwksFetches += 1;
  return Response.json(jwks);
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const bucket = (objects: Record<string, string> = {}) => {
  const archive = world(objects);
  return { ...archive, env: { ...archive.env, ...site } as unknown as Env };
};
const publish = async () => ({ authorization: `Bearer ${await jobToken()}` });
const put = (env: Env, name: string, body: string, headers: Record<string, string>) =>
  app.request(
    `https://data.example/v1/${name}`,
    {
      method: "PUT",
      headers: { "content-length": String(Buffer.byteLength(body)), ...headers },
      body,
    },
    env,
  );
const putFile = async (env: Env, name: string, body: string, digest = sha256(body)) =>
  put(env, name, body, { ...(await publish()), "x-content-sha256": digest });
const manifestOf = (files: Record<string, string>) =>
  JSON.stringify({
    counts: { dialects: 1 },
    files: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        { rows: 1, sha256: sha256(body), bytes: Buffer.byteLength(body) },
      ]),
    ),
  });
const putManifest = async (env: Env, manifest: string) =>
  put(env, "manifest.json", manifest, await publish());
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

test("each workflow route is guarded on the methods it names, and on nothing else", () => {
  // GET on the same path is the public table. A guard on every method there would lock the dataset.
  const guarded = [...new Set(workflowRoutes.routes.map((r) => `${r.method} ${r.path}`))].sort();
  assert.deepEqual(guarded, WORKFLOW_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  for (const route of WORKFLOW_ROUTES)
    assert.ok(
      !publicRoutes.routes.some((r) => r.path === route.path && r.method === route.method),
      `${route.method} ${route.path} is public as well`,
    );
});

test("publishing without publish.yml's token is refused, and the control token is not one", async () => {
  const { env, store } = bucket();
  const body = "model\nbattery\n";
  const digest = { "x-content-sha256": sha256(body) };
  const nothing = await put(env, "models.csv", body, digest);
  assert.equal(nothing.status, 401);
  assert.match(await errorOf(nothing), /publish\.yml/);
  // Holding the shared secret starts crawls. It must not also rewrite the dataset.
  const control = await put(env, "models.csv", body, {
    ...digest,
    authorization: "Bearer the-real-token",
  });
  assert.equal(control.status, 401);
  const deploy = await put(env, "models.csv", body, {
    ...digest,
    authorization: `Bearer ${await jobToken({ workflow_ref: "origin89hq/offgrid-equipment/.github/workflows/deploy.yml@refs/heads/main" })}`,
  });
  assert.equal(deploy.status, 401);
  assert.match(await errorOf(deploy), /workflow_ref/);
  assert.deepEqual([...store.keys()], [], "a refused publish wrote something");
});

test("a file whose body is its declared digest is written, and stays public to read", async () => {
  const { env, text } = bucket();
  const body = "model\nbattery\n";
  const res = await putFile(env, "models.csv", body);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { file: "models.csv", bytes: 14, sha256: sha256(body) });
  assert.equal(text("dataset/v1/models.csv"), body);
  const read = await app.request("https://data.example/v1/models.csv", {}, env);
  assert.equal(read.status, 200, "the public read now needs a token");
  assert.equal(await read.text(), body);
});

test("a file that is not what its digest says is refused, and the published one stays", async () => {
  const { env, text } = bucket({ "dataset/v1/models.csv": "the published table\n" });
  const res = await putFile(env, "models.csv", "a truncated tab", sha256("a truncated table\n"));
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /models\.csv is not the file whose sha256 was declared/);
  assert.equal(text("dataset/v1/models.csv"), "the published table\n");
});

test("a file sent without its digest or length, or under a name that is not a table, is refused", async () => {
  const { env, store } = bucket();
  const auth = await publish();
  const body = "model\nbattery\n";
  for (const digest of [undefined, sha256(body).toUpperCase(), sha256(body).slice(1)]) {
    const res = await put(env, "models.csv", body, {
      ...auth,
      ...(digest ? { "x-content-sha256": digest } : {}),
    });
    assert.equal(res.status, 400, `x-content-sha256 ${digest} was accepted`);
  }
  const unmeasured = await app.request(
    "https://data.example/v1/models.csv",
    { method: "PUT", headers: { ...auth, "x-content-sha256": sha256(body) }, body },
    env,
  );
  assert.equal(unmeasured.status, 411);
  for (const name of ["Models.csv", "models.exe", "%2e%2e%2fsecret.csv", "models.csv.json.gz"]) {
    const res = await putFile(env, name, body);
    assert.equal(res.status, 404, `${name} answered ${res.status}`);
  }
  assert.deepEqual([...store.keys()], []);
});

test("the manifest goes up last, once every file it names is stored as it says", async () => {
  const { env, text } = bucket();
  const files = { "models.csv": "model\nbattery\n", "models.parquet": "PAR1...PAR1" };
  for (const [name, body] of Object.entries(files))
    assert.equal((await putFile(env, name, body)).status, 200);
  const manifest = manifestOf(files);
  const res = await putManifest(env, manifest);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { file: "manifest.json", files: 2 });
  // Byte for byte what the build wrote, counts included.
  assert.equal(text("dataset/v1/manifest.json"), manifest);
  const index = (await (
    await app.request("https://data.example/manifest.json", {}, env)
  ).json()) as {
    files: Record<string, { url: string; sha256: string }>;
  };
  assert.deepEqual(Object.keys(index.files).sort(), ["models.csv", "models.parquet"]);
  assert.equal(index.files["models.csv"].sha256, sha256(files["models.csv"]));
});

test("a manifest naming a file missing, resized, or never checked is refused, and the old one stays", async () => {
  // models.parquet was put the old way, with no digest, so R2 has nothing to compare it with.
  const { env, text } = bucket({
    "dataset/v1/manifest.json": "the published manifest",
    "dataset/v1/models.parquet": "PAR1...PAR1",
  });
  assert.equal((await putFile(env, "models.csv", "model\nbattery\n")).status, 200);
  const manifest = manifestOf({
    "models.csv": "model\nbattery\ncharger\n",
    "models.parquet": "PAR1...PAR1",
    "specs.csv": "figure\n",
  });
  const res = await putManifest(env, manifest);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { files: string[] };
  assert.deepEqual(body.files, [
    "models.csv: 14 bytes stored, the manifest says 22",
    `models.parquet: stored sha256 is unrecorded, the manifest says ${sha256("PAR1...PAR1")}`,
    "specs.csv: not uploaded",
  ]);
  assert.equal(text("dataset/v1/manifest.json"), "the published manifest");
});

test("a manifest with the right size and the wrong digest is refused", async () => {
  const { env } = bucket();
  assert.equal((await putFile(env, "models.csv", "model\nbattery\n")).status, 200);
  const res = await putManifest(env, manifestOf({ "models.csv": "model\nbatterx\n" }));
  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { files: string[] }).files[0],
    /models\.csv: stored sha256 is /,
  );
});

test("a body that is not a manifest, or would unpublish the dataset, is refused", async () => {
  const { env, store } = bucket();
  for (const manifest of [
    "{not json",
    JSON.stringify({ counts: {} }),
    JSON.stringify({ files: {} }),
    JSON.stringify({ files: { "../../documents/x.csv": { bytes: 1, sha256: sha256("x") } } }),
    JSON.stringify({ files: { "manifest.json": { bytes: 1, sha256: sha256("x") } } }),
    JSON.stringify({ files: { "models.csv": { bytes: -1, sha256: sha256("x") } } }),
  ]) {
    const res = await putManifest(env, manifest);
    assert.equal(res.status, 400, `${manifest} answered ${res.status}`);
  }
  const huge = await put(env, "manifest.json", "{}", {
    ...(await publish()),
    "content-length": String(2 * 1024 * 1024),
  });
  assert.equal(huge.status, 413);
  const unmeasured = await app.request(
    "https://data.example/v1/manifest.json",
    { method: "PUT", headers: await publish(), body: "{}" },
    env,
  );
  assert.equal(unmeasured.status, 411, "a missing length is not a manifest that is too big");
  assert.deepEqual([...store.keys()], []);
});

test("GitHub's keys are fetched once and reused, not fetched per request", async () => {
  const { env } = bucket();
  for (let i = 0; i < 3; i += 1) await putFile(env, "models.csv", `model\n${i}\n`);
  assert.equal(jwksFetches, 1);
});

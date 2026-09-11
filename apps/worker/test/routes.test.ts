import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { READS_PER_REQUEST } from "@origin89/equipment-schema/provenance";
import { GITHUB_ISSUER } from "../src/oidc.ts";
import {
  app,
  CONTROL_PATHS,
  controlRoutes,
  memberPages,
  ndjsonRows,
  publicRoutes,
  WORKFLOW_ROUTES,
  workflowRoutes,
} from "../src/routes.ts";
import { datasetType } from "../src/runs.ts";
import { authRoutes } from "../src/sign-in.ts";
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

test("a control route with no token is refused rather than run, and says how to sign in", async () => {
  const res = await app.request("https://data.example/state", {}, site);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(String((body as { error?: string }).error), /just login/);
});

test("the only member page is the runs page, and it is not also public", () => {
  assert.deepEqual(paths(memberPages.routes), ["/ops/*"]);
  assert.ok(!paths(publicRoutes.routes).includes("/ops"));
});

test("the sign-in routes are these, and none of them is a control path", () => {
  // They have to be reachable without a session: they are how somebody gets one.
  assert.deepEqual(paths(authRoutes.routes), [
    "/auth/app",
    "/auth/callback",
    "/auth/login",
    "/auth/logout",
    "/auth/me",
  ]);
  for (const path of CONTROL_PATHS) assert.ok(!paths(authRoutes.routes).includes(path), path);
});

test("the wrong token is refused too", async () => {
  const res = await app.request(
    "https://data.example/state",
    { headers: { authorization: "Bearer not-the-real-token" } },
    site,
  );
  assert.equal(res.status, 401);
});

/** `just dev`, the one place the control token opens anything. */
const LOCAL = "http://localhost:8790";
const digest = (n: number) => String(n).padStart(64, "0");
const archive = (objects: Record<string, string>) => ({
  ...world(objects).env,
  CONTROL_TOKEN: "the-real-token",
});
const ask = (env: Env, body: unknown) =>
  app.request(
    `${LOCAL}/readings`,
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
    `${LOCAL}/readings`,
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
  assert.match(await errorOf(deploy), /from deploy\.yml; this route takes publish\.yml/);
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
  const accepted = (await res.json()) as {
    file: string;
    files: number;
    release: string;
    load: string;
  };
  assert.equal(accepted.file, "manifest.json");
  assert.equal(accepted.files, 2);
  assert.match(accepted.release, /^[a-f0-9]{64}$/);
  assert.equal(accepted.load, "not started", "a manifest without a load plan starts no load");
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

/** An instance whose status is `status`, or one the Workflows service no longer has. */
const instances = (statuses: Record<string, { status: string; error?: { message: string } }>) => ({
  get: async (id: string) => {
    const status = statuses[id];
    if (!status) throw new Error(`instance.not_found: ${id}`);
    return { status: async () => status };
  },
});

test("every current run that recorded an instance comes back with its workflow's status", async () => {
  const pointer = (run: string, instance?: string) =>
    JSON.stringify({
      run,
      date: run.slice(0, 10),
      startedAt: "",
      ...(instance ? { instance } : {}),
    });
  const env = {
    ...bucket({
      "documents/victron-energy/current.json": pointer(
        "2026-09-01-aaaa",
        "maker-victron-energy-2026-09-01-aaaa",
      ),
      "documents/rolls-battery/current.json": pointer("2026-09-01-bbbb"),
      "sightings/solacity/current.json": pointer("2026-09-07-cccc", "2026-09-07-cccc"),
      "sightings/thecabindepot/current.json": pointer("2026-09-07-dddd", "page-2026-09-07-dddd"),
    }).env,
    MANUFACTURER_CRAWL: instances({
      "maker-victron-energy-2026-09-01-aaaa": { status: "waiting" },
    }),
    SELLER_CRAWL: instances({
      "2026-09-07-cccc": { status: "errored", error: { message: "the feed answered 503" } },
    }),
    PAGE_CRAWL: instances({}),
  } as unknown as Env;
  const res = await app.request(
    `${LOCAL}/runs`,
    { headers: { authorization: "Bearer the-real-token" } },
    env,
  );
  assert.equal(res.status, 200);
  // Rolls recorded no instance, so there is nothing to ask. The page crawl's instance is gone,
  // which is shown rather than failing the list.
  assert.deepEqual(await res.json(), {
    runs: [
      {
        kind: "maker",
        entity: "victron-energy",
        run: "2026-09-01-aaaa",
        date: "2026-09-01",
        instance: "maker-victron-energy-2026-09-01-aaaa",
        status: "waiting",
        error: null,
      },
      {
        kind: "seller",
        entity: "solacity",
        run: "2026-09-07-cccc",
        date: "2026-09-07",
        instance: "2026-09-07-cccc",
        status: "errored",
        error: "the feed answered 503",
      },
      {
        kind: "seller",
        entity: "thecabindepot",
        run: "2026-09-07-dddd",
        date: "2026-09-07",
        instance: "page-2026-09-07-dddd",
        status: "unknown",
        error: "instance.not_found: page-2026-09-07-dddd",
      },
    ],
  });
});

test("the supervisor's last report is readable by a member, and its absence is a 404", async () => {
  const report = { at: "2026-09-10T08:00:03Z", started: [], blocked: [], concerns: ["one"] };
  const read = (env: Env) =>
    app.request(
      `${LOCAL}/supervision`,
      { headers: { authorization: "Bearer the-real-token" } },
      env,
    );
  const present = await read(bucket({ "supervision/latest.json": JSON.stringify(report) }).env);
  assert.equal(present.status, 200);
  assert.deepEqual(await present.json(), report);
  assert.equal((await read(bucket().env)).status, 404);
  const anonymous = await app.request("https://data.example/supervision", {}, bucket().env);
  assert.equal(anonymous.status, 401);
});

/** A job token from `workflow` on main, started by `event`, outside any environment. */
const jobFrom = (workflow: string, event: string, claims: Record<string, unknown> = {}) =>
  jobToken({
    workflow_ref: `origin89hq/offgrid-equipment/.github/workflows/${workflow}@refs/heads/main`,
    event_name: event,
    environment: undefined,
    ...claims,
  });
const asJob = (token: string, path: string, init: RequestInit = {}) =>
  app.request(
    `https://data.example${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    },
    bucket().env,
  );
const readOne = {
  method: "POST",
  body: JSON.stringify({ documents: [digest(1)], readers: ["text"] }),
};

test("the daily pull's job token reads the three routes it needs, and opens nothing else", async () => {
  const token = await jobFrom("pull-figures.yml", "schedule");
  assert.equal((await asJob(token, "/state")).status, 200);
  assert.equal(
    (await asJob(token, "/archive?prefix=documents/victron-energy/current.json")).status,
    200,
  );
  assert.equal((await asJob(token, "/readings", readOne)).status, 200);
  for (const path of ["/supervise", "/approve", "/run", "/vision", "/discover-all"]) {
    const res = await asJob(token, path, { method: "POST" });
    assert.equal(res.status, 403, `${path} answered ${res.status}`);
    assert.equal(await errorOf(res), `pull-figures.yml may not call ${path}`);
  }
});

test("the supervisor's job token reads state when started by hand, and not on a schedule", async () => {
  assert.equal(
    (await asJob(await jobFrom("supervise.yml", "workflow_dispatch"), "/state")).status,
    200,
  );
  const scheduled = await asJob(await jobFrom("supervise.yml", "schedule"), "/state");
  assert.equal(scheduled.status, 403);
  assert.match(await errorOf(scheduled), /started by schedule; this route takes workflow_dispatch/);
  const reading = await asJob(
    await jobFrom("supervise.yml", "workflow_dispatch"),
    "/readings",
    readOne,
  );
  assert.equal(reading.status, 403);
});

test("a job token from another workflow, event or branch opens no control route", async () => {
  // Publishing runs with the production secrets in reach; it has no business reading the archive.
  const publishing = await asJob(await jobToken(), "/state");
  assert.equal(publishing.status, 403);
  assert.equal(await errorOf(publishing), "publish.yml may not call /state");
  const pullRequest = await asJob(await jobFrom("pull-figures.yml", "pull_request"), "/state");
  assert.equal(pullRequest.status, 403);
  const check = await asJob(await jobFrom("check.yml", "workflow_dispatch"), "/state");
  assert.equal(check.status, 403);
  const branch = await asJob(
    await jobFrom("pull-figures.yml", "workflow_dispatch", {
      ref: "refs/heads/figures/pull",
      workflow_ref:
        "origin89hq/offgrid-equipment/.github/workflows/pull-figures.yml@refs/heads/figures/pull",
    }),
    "/state",
  );
  assert.equal(branch.status, 401, "a job on another branch is not a job this Worker knows");
});

test("the control token opens nothing on the deployed address, even if one were left behind", async () => {
  // The deploy deletes an old CONTROL_TOKEN secret. If that step ever failed, this is what holds.
  const env = bucket().env;
  const control = { headers: { authorization: "Bearer the-real-token" } };
  assert.equal((await app.request("https://data.origin89.com/state", control, env)).status, 401);
  for (const here of [LOCAL, "http://127.0.0.1:8790", "http://[::1]:8790"])
    assert.equal((await app.request(`${here}/state`, control, env)).status, 200, `${here} refused`);
});

test("a local control token shaped like a JWT still opens the control routes", async () => {
  const jwtShaped = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJsb2NhbCJ9.bG9jYWw";
  const env = { ...bucket().env, CONTROL_TOKEN: jwtShaped } as unknown as Env;
  const res = await app.request(
    `${LOCAL}/state`,
    { headers: { authorization: `Bearer ${jwtShaped}` } },
    env,
  );
  assert.equal(res.status, 200, "it was taken for a job token and checked against GitHub's keys");
});

test("the supervisor's job token runs a pass and offers a maker to the page reader", async () => {
  const token = () => jobFrom("supervise.yml", "workflow_dispatch");
  const pass = await asJob(await token(), "/supervise", { method: "POST" });
  assert.equal(pass.status, 200, await pass.clone().text());
  assert.deepEqual(Object.keys((await pass.json()) as object).sort(), [
    "at",
    "blocked",
    "concerns",
    "started",
  ]);

  const run = "documents/acme-power/runs/2026-09-10-abcd1234";
  const archive = bucket({
    "documents/acme-power/current.json": JSON.stringify({
      run: "2026-09-10-abcd1234",
      date: "2026-09-10",
      startedAt: "2026-09-10T08:00:00Z",
    }),
    [`${run}/converting.json`]: JSON.stringify({
      documents: [{ url: "https://acme.example/manual.pdf", sha256: digest(7) }],
    }),
    [`${run}/converted/${digest(7)}.json`]: "{}",
  });
  const offered = await app.request(
    "https://data.example/vision?id=acme-power&date=2026-09-10",
    { method: "POST", headers: { authorization: `Bearer ${await token()}` } },
    archive.env,
  );
  assert.equal(offered.status, 200, await offered.clone().text());
  assert.deepEqual(await offered.json(), { documents: 1 });
  assert.equal(archive.sent.length, 1, "no page reading was queued");
});

test("publication keeps immutable snapshots and exposes authenticated version comparisons", async () => {
  const { env, text } = bucket();
  const before = JSON.stringify([{ id: "battery", capacity: 100 }]);
  const after = JSON.stringify([
    { id: "battery", capacity: 120 },
    { id: "inverter", watts: 3000 },
  ]);
  const readHistory = async () => {
    const response = await app.request(
      `${LOCAL}/releases`,
      { headers: { authorization: "Bearer the-real-token" } },
      env,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as { releases: { id: string; sha: string; job: string }[] };
  };
  assert.equal((await putFile(env, "records_models.json", before)).status, 200);
  assert.equal((await putManifest(env, manifestOf({ "records_models.json": before }))).status, 200);
  const first = (await readHistory()).releases[0];
  await env.ARCHIVE.delete(`releases/snapshots/${sha256(before)}.json`);
  assert.equal((await putManifest(env, manifestOf({ "records_models.json": before }))).status, 409);
  await putFile(env, "records_models.json", before);
  assert.equal(first.sha.length, 40);
  assert.equal(first.job, "17000000001");
  assert.equal((await putFile(env, "records_models.json", after)).status, 200);
  assert.equal((await putManifest(env, manifestOf({ "records_models.json": after }))).status, 200);
  assert.equal(text(`releases/snapshots/${sha256(before)}.json`), before);
  assert.equal(text("dataset/v1/records_models.json"), after);
  const history = await readHistory();
  assert.equal(history.releases.length, 2);
  const second = history.releases.find((release) => release.id !== first.id);
  const compared = await app.request(
    `${LOCAL}/release-compare?from=${first.id}&to=${second?.id}`,
    { headers: { authorization: "Bearer the-real-token" } },
    env,
  );
  assert.equal(compared.status, 200, await compared.clone().text());
  assert.deepEqual(((await compared.json()) as { counts: unknown }).counts, {
    added: 1,
    removed: 0,
    changed: 1,
  });
  // A failed checksum must neither replace the current snapshot nor create historical content.
  assert.equal((await putFile(env, "records_models.json", "truncated", sha256(after))).status, 422);
  assert.equal(text(`releases/snapshots/${sha256(after)}.json`), after);
});

test("release indexing failure is repaired by republishing the same version", async () => {
  const { env, store } = bucket();
  const body = JSON.stringify([{ id: "battery", capacity: 100 }]);
  await putFile(env, "records_models.json", body);
  const manifest = manifestOf({ "records_models.json": body });
  const original = env.ARCHIVE.put.bind(env.ARCHIVE);
  let fail = true;
  env.ARCHIVE.put = (async (key, ...args) => {
    if (fail && key.startsWith("releases/feed/")) {
      fail = false;
      throw Error("index unavailable");
    }
    return original(key, ...args);
  }) as typeof env.ARCHIVE.put;
  assert.equal((await putManifest(env, manifest)).status, 500);
  assert.equal((await putManifest(env, manifest)).status, 200);
  assert.equal([...store.keys()].filter((key) => key.startsWith("releases/feed/")).length, 1);
  assert.equal([...store.keys()].filter((key) => key.startsWith("activity/feed/")).length, 1);
});

test("a failed public manifest write retains no attribution from the failed publishing job", async () => {
  const { env, store } = bucket();
  const body = JSON.stringify([{ id: "battery" }]);
  await putFile(env, "records_models.json", body);
  const manifest = manifestOf({ "records_models.json": body });
  const original = env.ARCHIVE.put.bind(env.ARCHIVE);
  let fail = true;
  env.ARCHIVE.put = (async (key, ...args) => {
    if (fail && key === "dataset/v1/manifest.json") {
      fail = false;
      throw Error("manifest unavailable");
    }
    return original(key, ...args);
  }) as typeof env.ARCHIVE.put;
  assert.equal((await putManifest(env, manifest)).status, 500);
  // The immutable record is written before the public manifest so a load can start from it
  // (#83); the history that names the job is written only once the manifest is public.
  assert.equal([...store.keys()].filter((key) => key.startsWith("releases/feed/")).length, 0);
  const response = await put(env, "manifest.json", manifest, {
    authorization: `Bearer ${await jobToken({ sha: "b".repeat(40), run_id: "17000000002", run_attempt: "2" })}`,
  });
  assert.equal(response.status, 200);
  const history = await app.request(
    `${LOCAL}/releases`,
    { headers: { authorization: "Bearer the-real-token" } },
    env,
  );
  const entry = (
    (await history.json()) as { releases: { sha: string; job: string; attempt: string }[] }
  ).releases[0];
  assert.equal(entry.sha, "b".repeat(40));
  assert.equal(entry.job, "17000000002");
  assert.equal(entry.attempt, "2");
});

test("a load part is kept content-addressed, and the manifest's load plan is checked against what is stored (#83)", async () => {
  const { env, text } = bucket();
  const part = '{"id":"a"}\n';
  assert.equal((await putFile(env, "models_0001.ndjson", part)).status, 200);
  // A count the bytes contradict is refused, however consistently the plan repeats it.
  const two = '{"id":"a"}\n{"id":"b"}\n';
  await putFile(env, "models_0002.ndjson", two);
  const lied = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0002.ndjson": two })),
    load: { version: 1, tables: { models: { parts: ["models_0002.ndjson"], rows: 1 } } },
  });
  assert.match(
    JSON.stringify(await (await putManifest(env, lied)).json()),
    /holds 2 records, the manifest says 1/,
  );
  const encode = (text: string) => new TextEncoder().encode(text);
  assert.equal(
    ndjsonRows(encode('{"a":1}\n\n{"b":2}\r\n \n{"c":3}')),
    3,
    "blank lines are no records, and a last line without its newline is one",
  );
  assert.throws(() => ndjsonRows(encode('{"a":1}\nnot-json\n')), /line 2 is not JSON/);
  assert.throws(() => ndjsonRows(encode("[]\n")), /line 1 is not a JSON object/);
  assert.throws(() => ndjsonRows(encode("{}\n".repeat(20_001))), /more than 20000 records/);
  assert.throws(
    () => ndjsonRows(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a])),
    /not UTF-8/,
    "bytes that are not UTF-8 are refused, not replaced",
  );
  const unnumbered = await put(env, "models.ndjson", part, {
    ...(await publish()),
    "x-content-sha256": sha256(part),
  });
  assert.equal(
    unnumbered.status,
    404,
    "an NDJSON file that is not a numbered part is no dataset file",
  );
  assert.equal(datasetType("models.csv"), "text/csv; charset=utf-8");
  const csvOnly = "id\nx\n";
  await putFile(env, "specs.csv", csvOnly);
  const uncovered = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0001.ndjson": part, "specs.csv": csvOnly })),
    load: { version: 1, tables: { models: { parts: ["models_0001.ndjson"], rows: 1 } } },
  });
  assert.match(
    JSON.stringify(await (await putManifest(env, uncovered)).json()),
    /specs: published as a table and absent from the load plan/,
  );
  const malformed = await putFile(env, "models_0003.ndjson", '{"id":"a"}\n[]\n');
  assert.equal(malformed.status, 422, "a malformed part is refused before it is stored");
  assert.match(await errorOf(malformed), /line 2 is not a JSON object/);
  const planless = await putManifest(env, manifestOf({ "models_0001.ndjson": part }));
  assert.match(
    JSON.stringify(await planless.json()),
    /no load plan says which table/,
    "parts without a plan are not a release",
  );
  const cousin = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0001.ndjson": part })),
    load: { version: 1, tables: { model_keys: { parts: ["models_0001.ndjson"], rows: 1 } } },
  });
  assert.match(
    JSON.stringify(await (await putManifest(env, cousin)).json()),
    /named for another table/,
    "a part is matched to its whole table name",
  );
  const bloated = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0001.ndjson": part })),
    files: {
      "models_0001.ndjson": { rows: 20_001, sha256: sha256(part), bytes: Buffer.byteLength(part) },
    },
    load: { version: 1, tables: { models: { parts: ["models_0001.ndjson"], rows: 20_001 } } },
  });
  assert.match(
    JSON.stringify(await (await putManifest(env, bloated)).json()),
    /over the 20000 a part may hold/,
  );
  assert.equal(text("dataset/v1/models_0001.ndjson"), part);
  assert.equal(text(`releases/loads/${sha256(part)}.ndjson`), part, "the immutable copy");
  assert.equal(datasetType("models_0001.ndjson"), "application/x-ndjson; charset=utf-8");
  const manifest = (plan: unknown) =>
    JSON.stringify({
      ...JSON.parse(manifestOf({ "models_0001.ndjson": part })),
      load: plan,
    });
  const good = {
    version: 1,
    tables: { models: { parts: ["models_0001.ndjson"], rows: 1, key: "id" } },
  };
  assert.equal((await putManifest(env, manifest(good))).status, 200);
  const elsewhere = { version: 1, tables: { specs: { parts: ["models_0001.ndjson"], rows: 1 } } };
  const wrongTable = await putManifest(env, manifest(elsewhere));
  assert.equal(wrongTable.status, 409, "a part is named for the table it loads");
  assert.match(JSON.stringify(await wrongTable.json()), /named for another table/);
  const twice = {
    version: 1,
    tables: { models: { parts: ["models_0001.ndjson", "models_0001.ndjson"], rows: 2 } },
  };
  assert.match(
    JSON.stringify(await (await putManifest(env, manifest(twice))).json()),
    /assigned twice/,
  );
  const uncounted = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0001.ndjson": part })),
    files: { "models_0001.ndjson": { sha256: sha256(part), bytes: Buffer.byteLength(part) } },
    load: { version: 1, tables: { models: { parts: ["models_0001.ndjson"], rows: 0 } } },
  });
  assert.match(
    JSON.stringify(await (await putManifest(env, uncounted)).json()),
    /states no row count/,
  );
  const stray = '{"id":"s"}\n';
  await putFile(env, "specs_0001.ndjson", stray);
  const partial = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0001.ndjson": part, "specs_0001.ndjson": stray })),
    load: { version: 1, tables: { models: { parts: ["models_0001.ndjson"], rows: 1 } } },
  });
  assert.match(
    JSON.stringify(await (await putManifest(env, partial)).json()),
    /specs_0001.ndjson: a load part in no table's plan/,
    "a plan that leaves a table out is not a plan",
  );
  const unlisted = { version: 1, tables: { models: { parts: ["models_0002.ndjson"], rows: 1 } } };
  const missing = await putManifest(env, manifest(unlisted));
  assert.equal(missing.status, 409);
  assert.deepEqual(((await missing.json()) as { files: string[] }).files, [
    "models: load part models_0002.ndjson is not in the manifest",
    "models: its load parts hold 0 rows, the plan says 1",
    "models_0001.ndjson: a load part in no table's plan",
  ]);
  await env.ARCHIVE.delete(`releases/loads/${sha256(part)}.ndjson`);
  const gone = await putManifest(env, manifest(good));
  assert.equal(gone.status, 409);
  assert.match(JSON.stringify(await gone.json()), /immutable load part is missing/);
  const index = (await (
    await app.request("https://data.example/manifest.json", {}, env)
  ).json()) as { load?: unknown };
  assert.deepEqual(
    index.load,
    good,
    "the public index carries the plan a reader of the parts needs",
  );
  const wrongPlan = await putManifest(env, manifest({ version: 2, tables: {} }));
  assert.equal(wrongPlan.status, 400, "a plan of another version is not a manifest");
  const huge = await put(env, "models_0002.ndjson", "x", {
    ...(await publish()),
    "x-content-sha256": sha256("x"),
    "content-length": String(16 * 1024 * 1024 + 1),
  });
  assert.equal(huge.status, 413);
});

test("an accepted manifest with a load plan starts the release's load, once (#83)", async () => {
  const { env, loads, store, text } = bucket();
  const part = '{"id":"a"}\n';
  await putFile(env, "models_0001.ndjson", part);
  const withPlan = JSON.stringify({
    ...JSON.parse(manifestOf({ "models_0001.ndjson": part })),
    load: { version: 1, tables: { models: { parts: ["models_0001.ndjson"], rows: 1, key: "id" } } },
  });
  const first = await putManifest(env, withPlan);
  assert.equal(first.status, 200);
  const answer = (await first.json()) as { release: string; load: string };
  assert.equal(answer.load, "started");
  assert.deepEqual(loads, [{ id: `load-${answer.release}`, params: { release: answer.release } }]);
  const again = await putManifest(env, withPlan);
  assert.equal(
    ((await again.json()) as { load: string }).load,
    "already",
    "a retried manifest starts no second load",
  );
  assert.equal(loads.length, 1);
  // The same attempt with another plan is not the same publication: the record already made
  // carries the first plan, so the second is refused rather than loaded against it.
  const otherPlan = JSON.stringify({
    ...JSON.parse(withPlan),
    load: { version: 1, tables: { models: { parts: ["models_0001.ndjson"], rows: 1 } } },
  });
  const changed = await putManifest(env, otherPlan);
  assert.equal(changed.status, 409);
  assert.match(await errorOf(changed), /different load plan/);
  // A load that cannot be started leaves the front door and the history as they were: the
  // publisher's one request fails, and its rerun is a new attempt that starts a new load.
  const before = text("dataset/v1/manifest.json");
  const create = env.RELEASE_LOAD.create;
  env.RELEASE_LOAD.create = async () => {
    throw new Error("Workflows is away");
  };
  const rerun = {
    authorization: `Bearer ${await jobToken({ sha: "b".repeat(40), run_id: "17000000002", run_attempt: "1" })}`,
  };
  assert.equal((await put(env, "manifest.json", withPlan, rerun)).status, 500);
  assert.equal(text("dataset/v1/manifest.json"), before, "no manifest went public");
  const feed = [...store.keys()].filter((key) => key.startsWith("releases/feed/"));
  assert.equal(feed.length, 1, "the failed publication is not in the history");
  env.RELEASE_LOAD.create = create;
  await putFile(env, "models.csv", "id\na\n");
  const bare = await putManifest(env, manifestOf({ "models.csv": "id\na\n" }));
  assert.equal(
    ((await bare.json()) as { load: string }).load,
    "not started",
    "no parts and no plan, nothing to load",
  );
});

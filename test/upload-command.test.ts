import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { app } from "../apps/worker/src/routes.ts";
import { jobToken, jwks } from "../apps/worker/test/github-token.ts";
import { world } from "../apps/worker/test/world.ts";
import { loadRecords } from "../src/records.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "offgrid-upload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const dir = join(root, "input files");
  const calls = join(root, "calls.jsonl");
  mkdirSync(bin);
  mkdirSync(dir);
  const shim = join(bin, "pnpm");
  writeFileSync(
    shim,
    `#!${process.execPath}
    const fs = require('node:fs');
    if (!fs.existsSync('wrangler.jsonc')) throw new Error('Missing Worker config');
    fs.appendFileSync(process.env.UPLOAD_CALLS, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)})+'\\n');
  `,
  );
  chmodSync(shim, 0o755);
  return {
    dir,
    calls: (): { cwd: string; args: string[] }[] =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    run: (script: string, ...flags: string[]) =>
      spawnSync(
        process.execPath,
        [new URL(`../tools/${script}`, import.meta.url).pathname, "--dir", dir, ...flags],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPLOAD_CALLS: calls },
        },
      ),
  };
}
function dataset(dir: string, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { "models.csv": "model\nbattery\n", ...extra };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [
          name,
          {
            rows: 1,
            bytes: Buffer.byteLength(bytes),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ]),
      ),
    }),
  );
}
interface Seen {
  method: string;
  path: string;
  authorization?: string;
  sha256?: string;
  length?: string;
  body: string;
}

/**
 * GitHub's token endpoint and the Worker's write route on one local port, recording every request.
 * `answer` replaces the stub's answer for any request it returns a response for.
 */
async function endpoints(
  t: TestContext,
  answer: (
    path: string,
    request: Request,
  ) => Promise<Response | undefined> | Response | undefined = () => undefined,
) {
  const seen: Seen[] = [];
  let issued = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://localhost");
    const sha256 = req.headers["x-content-sha256"];
    seen.push({
      method: req.method ?? "",
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
      sha256: typeof sha256 === "string" ? sha256 : undefined,
      length: req.headers["content-length"],
      body: body.toString(),
    });
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([name, value]) =>
        typeof value === "string" ? [[name, value] as [string, string]] : [],
      ),
      ...(body.length ? { body } : {}),
    });
    const answered = await answer(url.pathname, request);
    if (answered) {
      res.writeHead(answered.status, Object.fromEntries(answered.headers));
      res.end(Buffer.from(await answered.arrayBuffer()));
    } else if (url.pathname === "/manifest.json") {
      res.end(JSON.stringify({ publication: { historyVersion: 3 } }));
    } else if (url.pathname === "/token") {
      issued += 1;
      res.end(JSON.stringify({ value: `job-token-${issued}` }));
    } else res.end("{}");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => new Promise<void>((closed) => server.close(() => closed())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    // What the runner sets in a job with id-token: write.
    job: {
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
      OFFGRID_BASE_URL: origin,
    },
  };
}

/**
 * Run the publisher without blocking this process, so the endpoints above can answer it. Only the
 * environment given: a token-request variable leaking in from a real job would change the test.
 */
function publishing(dir: string, env: Record<string, string>, ...flags: string[]) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((finished) => {
    execFile(
      process.execPath,
      [new URL("../tools/dataset/publish.ts", import.meta.url).pathname, "--dir", dir, ...flags],
      { cwd: tmpdir(), timeout: 15000, env: { PATH: process.env.PATH ?? "", ...env } },
      (error, stdout, stderr) =>
        finished({
          status: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

const TOKEN_REQUEST = "GET /token?api-version=2.0&audience=https%3A%2F%2Fdata.origin89.com";

test("every file goes up with its digest and a fresh job token, and the manifest goes last", async (t) => {
  const { dir } = fixture(t);
  dataset(dir);
  const { seen, job } = await endpoints(t);
  const result = await publishing(dir, job);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    seen.slice(1).map((s) => `${s.method} ${s.path}`),
    [TOKEN_REQUEST, "PUT /v1/models.csv", TOKEN_REQUEST, "PUT /v1/manifest.json"],
  );
  assert.match(seen[0].path, /^\/manifest\.json\?publication-check=/);
  assert.equal(seen[0].authorization, undefined);
  const [token, file, , manifest] = seen.slice(1);
  assert.equal(token.authorization, "Bearer runner-request-token");
  assert.equal(file.authorization, "Bearer job-token-1");
  assert.equal(file.sha256, createHash("sha256").update("model\nbattery\n").digest("hex"));
  assert.equal(file.length, "14");
  assert.equal(file.body, "model\nbattery\n");
  assert.equal(manifest.authorization, "Bearer job-token-2");
  assert.equal(manifest.body, readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.match(result.stdout, /2 files published/);
});

test("a load part is a file of the build like any other, found on disk and sent (#83)", async (t) => {
  const { dir } = fixture(t);
  dataset(dir, { "models_0001.ndjson": '{"id":"battery"}\n' });
  const { seen, job } = await endpoints(t);
  const result = await publishing(dir, job);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    seen.slice(1).flatMap((s) => (s.method === "PUT" ? [s.path] : [])),
    ["PUT /v1/models.csv", "PUT /v1/models_0001.ndjson", "PUT /v1/manifest.json"].map((p) =>
      p.slice(4),
    ),
  );
  assert.match(result.stdout, /3 files published/);
});

test("a dry run sends nothing and needs no token", async (t) => {
  const { dir } = fixture(t);
  dataset(dir);
  const { seen, origin } = await endpoints(t);
  const result = await publishing(dir, { OFFGRID_BASE_URL: origin }, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 files would be published/);
  assert.deepEqual(seen, []);
});

test("a build that disagrees with its own manifest is refused before anything is sent", async (t) => {
  const { dir } = fixture(t);
  dataset(dir);
  writeFileSync(join(dir, "models.csv"), "model\nchanged\n");
  const { seen, job } = await endpoints(t);
  const result = await publishing(dir, job);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha256 disagrees/);
  assert.deepEqual(seen, []);
});

test("outside a GitHub Actions job it refuses and says where publishing runs", async (t) => {
  const { dir } = fixture(t);
  dataset(dir);
  const { seen, origin } = await endpoints(t);
  const result = await publishing(dir, { OFFGRID_BASE_URL: origin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runs in publish\.yml/);
  assert.match(result.stderr, /--dry-run/);
  assert.deepEqual(seen, []);
});

test("a file the Worker refuses stops the publish with its reason, and no manifest follows", async (t) => {
  const { dir } = fixture(t);
  dataset(dir);
  const reason = '{"error":"models.csv is not the file whose sha256 was declared"}';
  const { seen, job } = await endpoints(t, (path) =>
    path === "/v1/models.csv" ? new Response(reason, { status: 422 }) : undefined,
  );
  const result = await publishing(dir, job);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refused models\.csv: HTTP 422/);
  assert.ok(result.stderr.includes(reason), result.stderr);
  assert.ok(!seen.some((s) => s.path === "/v1/manifest.json"), "the manifest went up anyway");
});

test("GitHub refusing a job token stops the publish before any upload", async (t) => {
  const { dir } = fixture(t);
  dataset(dir);
  const { seen, job } = await endpoints(t, (path) =>
    path === "/token" ? new Response("no id-token permission", { status: 403 }) : undefined,
  );
  const result = await publishing(dir, job);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /would not issue a job token: HTTP 403/);
  assert.deepEqual(
    seen.map((s) => s.method),
    ["GET", "GET"],
  );
});

test("what the publisher sends is what the Worker takes: files, digests, and the manifest last", async (t) => {
  // The two halves are tested apart above and in the Worker's own tests. This is the seam: the
  // real publisher, a job token signed as GitHub would, and the Worker's real route in front of an
  // archive in memory.
  const { dir } = fixture(t);
  dataset(dir);
  const archive = world();
  const env = { ...archive.env, SITE: { fetch: async () => new Response("the site") } } as Env;
  t.mock.method(globalThis, "fetch", async () => Response.json(jwks));
  const { job } = await endpoints(t, async (path, request) =>
    path === "/token" ? Response.json({ value: await jobToken() }) : app.fetch(request, env),
  );
  const result = await publishing(dir, job);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(archive.text("dataset/v1/models.csv"), "model\nbattery\n");
  assert.equal(
    archive.text("dataset/v1/manifest.json"),
    readFileSync(join(dir, "manifest.json"), "utf8"),
  );
});

test("logo upload finds the moved Worker and keeps absolute file arguments", (t) => {
  const { dir, calls, run } = fixture(t);
  const maker = loadRecords().manufacturers.find((item) => item.logo?.widths.length);
  assert.ok(maker?.logo);
  const name = `${maker.id}-${maker.logo.widths[0]}.png`;
  writeFileSync(join(dir, name), "test image bytes");
  const result = run("logos/upload.ts");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().length, 1);
  const call = calls()[0];
  assert.equal(call.cwd, new URL("../apps/worker/", import.meta.url).pathname.replace(/\/$/, ""));
  assert.equal(call.args[call.args.indexOf("--file") + 1], join(dir, name));
});

test("an older Worker is refused before any credential request or upload", async (t) => {
  // One with no release history at all, and one that loads releases but keeps snapshots whole.
  for (const index of [{ files: {} }, { files: {}, publication: { historyVersion: 2 } }]) {
    const { dir } = fixture(t);
    dataset(dir);
    const { seen, job } = await endpoints(t, (path) =>
      path === "/manifest.json" ? Response.json(index) : undefined,
    );
    const result = await publishing(dir, job);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not keep record snapshots in parts yet/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "GET");
    assert.match(seen[0].path, /^\/manifest\.json\?publication-check=/);
    assert.equal(seen[0].authorization, undefined);
  }
});

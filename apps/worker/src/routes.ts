import { APPROVAL_EVENT, CrawlApproval } from "@origin89/equipment-schema/documents";
import { READS_PER_REQUEST } from "@origin89/equipment-schema/provenance";
import { type Context, Hono } from "hono";
import { z } from "zod";
import specPages from "../../../feeds/spec-pages.json" with { type: "json" };
import { bearer } from "./authorised.ts";
import { classifyRun, convertRun, specPagesRun, visionRun } from "./enqueue.ts";
import { hasFeed } from "./feeds.ts";
import { LeaseHeld, OFFER_LEASE_MS, underLease } from "./lease.ts";
import { manufacturers } from "./manufacturers.ts";
import {
  admits,
  GitHubKeysUnavailable,
  type Job,
  type JobCheck,
  PRODUCTION,
  verifyJob,
  verifyWorkflow,
  type WorkflowCheck,
  type WorkflowRule,
} from "./oidc.ts";
import {
  ARCHIVE_ROOTS,
  currentRuns,
  DATASET_PATH,
  datasetKey,
  datasetType,
  LOGO_PATH,
  newRun,
  pointerKey,
  readable,
  readPointer,
} from "./runs.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";
import { sellers } from "./sellers.ts";
import {
  authRoutes,
  type Caller,
  type Identified,
  identify,
  localControlToken,
} from "./sign-in.ts";
import { makerStates, sellerStates } from "./state.ts";
import { supervise } from "./supervise.ts";
import { partKey } from "./work.ts";

/**
 * Every route the Worker answers, split by who may call it.
 *
 * The split is the point. This was a chain of ifs with one `authorised` check partway down, so
 * whether a route was public depended on where somebody wrote it — above the check or below it.
 * A route added in the wrong place would have been silently open, and nothing would have said so.
 * Now `public` holds the three anyone may call, `auth` the ones that sign somebody in, `control`
 * the rest behind a middleware that runs before any of its handlers, and `workflow` what only a
 * named GitHub workflow may call. A test walks the tables rather than a list of names.
 */

type Env = Cloudflare.Env;
type App = Hono<{ Bindings: Env }>;

/** Today as YYYY-MM-DD in UTC. Computed once per trigger and passed in, never inside a step. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Which instance owns a maker's current run, so a caller can approve without knowing an id. */
async function currentInstance(env: Env, manufacturerId: string): Promise<string | undefined> {
  return (await readPointer(env.ARCHIVE, pointerKey.documents(manufacturerId)))?.instance;
}

/**
 * What anyone may read: the front door, a maker's mark, and a published table.
 *
 * A page that renders the catalogue cannot carry the control token, and a token shipped to a
 * browser is a token published. Nothing else in the archive is reachable here.
 */
export const publicRoutes: App = new Hono<{ Bindings: Env }>();

/**
 * What is published, as JSON, at an address of its own.
 *
 * It used to answer on "/" whenever a caller did not ask for HTML, which meant `curl` on the front
 * door returned a wall of JSON to somebody who wanted the page. An Accept header is a preference,
 * not an address: "/" is the site, and this is the index.
 */
publicRoutes.on(["GET", "HEAD"], "/manifest.json", async (c) => {
  const manifest = await c.env.ARCHIVE.get(datasetKey("manifest.json"));
  const published = manifest
    ? await manifest.json<{
        counts?: Record<string, number>;
        files?: Record<string, { rows: number; bytes: number; sha256: string }>;
      }>()
    : undefined;
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      name: "offgrid-equipment",
      description:
        "Off-grid power equipment: manufacturers, models, rated figures and the protocols a controller can speak to them with.",
      licence: "MIT, for the tooling and the records alike",
      repository: "https://github.com/origin89hq/offgrid-equipment",
      contact: "hello@origin89.com",
      provenance:
        "Every figure names the document it came from, the page, and whether a model read it or a parser did.",
      logos: {
        note: "A maker's mark is a trademark, not part of the MIT grant. Served here to identify the maker; ask the maker for any other use.",
        url: `${origin}/logos/<manufacturer>-<width>.png`,
      },
      ...(published?.counts ? { counts: published.counts } : {}),
      index: `${origin}/manifest.json`,
      files: Object.fromEntries(
        Object.entries(published?.files ?? {}).map(([name, meta]) => [
          name,
          { ...meta, url: `${origin}/v1/${name}` },
        ]),
      ),
    },
    200,
    { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  );
});

/** The front door is the site. Always. */
publicRoutes.on(["GET", "HEAD"], "/", async (c) => c.env.SITE.fetch(c.req.raw));

publicRoutes.on(["GET", "HEAD"], "/logos/:file", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!LOGO_PATH.test(path)) return c.notFound();
  const object = await c.env.ARCHIVE.get(path.slice(1));
  if (!object) return c.text("no such logo", 404);
  return new Response(c.req.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": "image/png",
      // Addressed by maker and width, and a maker's mark changes about never.
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "access-control-allow-origin": "*",
    },
  });
});

publicRoutes.on(["GET", "HEAD"], "/v1/:file", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!DATASET_PATH.test(path)) return c.notFound();
  const name = path.slice("/v1/".length);
  // A range, because that is how a query engine reads Parquet: the footer first, then the row
  // groups it needs. Serving only whole files would make every question cost the file.
  const asked = c.req.header("range");
  const object = await c.env.ARCHIVE.get(
    datasetKey(name),
    asked ? { range: c.req.raw.headers } : undefined,
  );
  if (!object) return c.text("no such file", 404);
  // Only what the caller asked for. R2 reports a range on every object, covering the whole file
  // when none was requested, and answering 206 to a request that carried no Range header is a
  // partial response to a question nobody asked. A suffix range comes back without an offset, so
  // both ends are resolved before they reach a header.
  const range = asked ? object.range : undefined;
  const bounds =
    range && "offset" in range && range.offset !== undefined && range.length !== undefined
      ? { offset: range.offset, length: range.length }
      : range && "suffix" in range && range.suffix !== undefined
        ? { offset: object.size - range.suffix, length: range.suffix }
        : undefined;
  const part = bounds && bounds.length < object.size ? bounds : undefined;
  return new Response(c.req.method === "HEAD" ? null : object.body, {
    status: part ? 206 : 200,
    headers: {
      "content-type": datasetType(name),
      "content-length": String(part ? part.length : object.size),
      "accept-ranges": "bytes",
      ...(part
        ? {
            "content-range": `bytes ${part.offset}-${part.offset + part.length - 1}/${object.size}`,
          }
        : {}),
      // A build is reproducible and its bytes are pinned by the manifest, so a stale copy is a
      // wrong answer rather than an old one. Short, and revalidated.
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "access-control-allow-origin": "*",
      etag: `"${object.httpEtag.replaceAll(String.fromCharCode(34), "")}"`,
    },
  });
});

/**
 * Everything that starts work or reads the archive, for members of the working group. Who is
 * calling is settled before any handler runs.
 */
export const controlRoutes = new Hono<{ Bindings: Env; Variables: { caller: Caller } }>();

/**
 * Every path that needs a member, named once.
 *
 * The guard is applied to these and not to `*`. A middleware on `*` reaches anything the public
 * routes did not match, which included the site's own stylesheet — the page would have loaded and
 * then refused to dress itself, with a 401 on a file nobody thinks of as protected.
 */
export const CONTROL_PATHS = [
  "/approve",
  "/archive",
  "/classify",
  "/convert",
  "/discover-all",
  "/maker",
  "/readings",
  "/run",
  "/runs",
  "/spec-pages",
  "/state",
  "/status",
  "/supervise",
  "/supervision",
  "/vision",
] as const;

type ControlPath = (typeof CONTROL_PATHS)[number];

/**
 * The workflows that call control routes, and the routes each may call. Neither deploys, so
 * neither needs the production environment, and the daily pull starts on a schedule.
 */
export const CONTROL_WORKFLOWS: readonly (WorkflowRule & { paths: readonly ControlPath[] })[] = [
  {
    workflow: "pull-figures.yml",
    events: ["schedule", "workflow_dispatch"],
    paths: ["/state", "/archive", "/readings"],
  },
  {
    workflow: "supervise.yml",
    events: ["workflow_dispatch"],
    paths: ["/supervise", "/state", "/vision"],
  },
];

/** A GitHub job token, as opposed to a person's token or the control token. */
const JOB_TOKEN = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;

function logWorkflowCall(method: string, path: string, job: Job): void {
  console.log(
    JSON.stringify({
      message: "workflow call",
      method,
      path,
      workflow: job.workflow,
      run: job.runId,
      sha: job.sha,
    }),
  );
}

/**
 * Who is calling a control route. The control token comes first, whatever it looks like, so a
 * local one shaped like a JWT still works. A job token is checked against the workflows allowed on
 * this route; anything else goes through sign-in.
 */
async function controlCaller(
  c: Context<{ Bindings: Env; Variables: { caller: Caller } }>,
  path: ControlPath,
): Promise<Identified> {
  if (await localControlToken(c)) return { ok: true, caller: { kind: "control token" } };
  const token = bearer(c.req.raw);
  if (!token || !JOB_TOKEN.test(token)) return identify(c);
  let checked: JobCheck;
  try {
    checked = await verifyJob(token);
  } catch (error) {
    if (error instanceof GitHubKeysUnavailable)
      return { ok: false, status: 503, error: error.message };
    throw error;
  }
  if (!checked.ok) return { ok: false, status: 401, error: checked.reason };
  const { job } = checked;
  const rule = CONTROL_WORKFLOWS.find((allowed) => allowed.workflow === job.workflow);
  if (!rule?.paths.includes(path))
    return { ok: false, status: 403, error: `${job.workflow} may not call ${path}` };
  const admitted = admits(rule, job);
  if (!admitted.ok) return { ok: false, status: 403, error: admitted.reason };
  logWorkflowCall(c.req.method, path, job);
  return { ok: true, caller: { kind: "workflow", workflow: job.workflow, runId: job.runId } };
}

// Registered before the handlers, because Hono runs a path's middleware in the order it was added.
for (const path of CONTROL_PATHS) {
  controlRoutes.use(path, async (c, next) => {
    const who = await controlCaller(c, path);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    c.set("caller", who.caller);
    await next();
  });
}

controlRoutes.post("/run", async (c) => {
  const sellerId = c.req.query("seller");
  const seller = sellers.find((s) => s.id === sellerId);
  if (!sellerId || !seller) return c.json({ error: "unknown seller" }, 400);
  const run = newRun();
  if (hasFeed(seller)) {
    const params: SellerCrawlParams = { sellerId, run: run.id, checkedAt: run.date };
    const instance = await c.env.SELLER_CRAWL.create({ id: run.id, params });
    return c.json({ id: instance.id, tier: "feed" });
  }
  const limit = c.req.query("limit");
  const instance = await c.env.PAGE_CRAWL.create({
    id: `page-${run.id}`,
    params: {
      sellerId,
      run: run.id,
      checkedAt: run.date,
      ...(limit ? { limit: Number(limit) } : {}),
    },
  });
  return c.json({ id: instance.id, tier: "page" });
});

// What the spider knows and what it is waiting on, read out of the archive rather than kept
// beside it. A weekly cron can lose a dozen crawls and nothing would say so otherwise.
/** A pass already running is an answer the caller can read, not a server error. */
const leaseHeld = (error: unknown): { error: string } | undefined =>
  error instanceof LeaseHeld ? { error: error.message } : undefined;

controlRoutes.post("/supervise", async (c) => {
  try {
    return c.json(await supervise(c.env, c.req.query("date") ?? today()));
  } catch (error) {
    const held = leaseHeld(error);
    if (held) return c.json(held, 409);
    throw error;
  }
});

controlRoutes.get("/state", async (c) => {
  const [sellerState, makerState] = await Promise.all([
    sellerStates(c.env.ARCHIVE),
    makerStates(c.env.ARCHIVE),
  ]);
  return c.json({ sellers: sellerState, makers: makerState });
});

// Reading a run back one object at a time meant spawning wrangler once per part, which took longer
// than producing the results. R2 can list and the Worker can stream, so a whole run comes back in
// one request.
controlRoutes.get("/archive", async (c) => {
  const prefix = c.req.query("prefix");
  if (!prefix || !readable(prefix)) {
    return c.json(
      { error: `prefix must start with one of ${ARCHIVE_ROOTS.map((r) => `${r}/`).join(", ")}` },
      400,
    );
  }
  if (c.req.query("list") === "true") {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) keys.push(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return c.json({ prefix, keys: keys.sort() });
  }
  // Each object separated by a newline, so a caller can split whatever the objects hold: JSONL
  // parts concatenate into JSONL, and JSON documents into one per line.
  const bucket = c.env.ARCHIVE;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let cursor: string | undefined;
      try {
        do {
          const page = await bucket.list({ prefix, cursor, limit: 1000 });
          for (const listed of [...page.objects].sort((a, b) => a.key.localeCompare(b.key))) {
            const object = await bucket.get(listed.key);
            if (!object) continue;
            const text = (await object.text()).replace(/\n+$/, "");
            if (text) controller.enqueue(encoder.encode(`${text}\n`));
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
});

/** How many readings are fetched at once. One at a time, a full batch is a minute of waiting. */
const READS_AT_ONCE = 16;

/** A content address and a reader key: nothing that could interpolate into another key. */
const DIGEST = /^[0-9a-f]{64}$/;
const READER = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Every reading of the documents asked for, in one response.
 *
 * A reading is addressed by the bytes it read, so a maker's readings are scattered across a flat
 * prefix with nothing to stream by, and asking for them one at a time cost a round trip each:
 * four thousand documents across three readers is thirteen thousand round trips, and the nightly
 * pull was heading past its hour. The caller already holds the document list, so it says which
 * ones it wants and the reads happen next to the bucket.
 */
controlRoutes.post("/readings", async (c) => {
  const asked = await c.req
    .json<{ documents?: unknown; readers?: unknown }>()
    .catch(() => undefined);
  const documents = Array.isArray(asked?.documents) ? asked.documents : [];
  const readers = Array.isArray(asked?.readers) ? asked.readers : [];
  if (documents.length === 0) return c.json({ error: "documents required" }, 400);
  if (readers.length === 0) return c.json({ error: "readers required" }, 400);
  if (!documents.every((d): d is string => typeof d === "string" && DIGEST.test(d)))
    return c.json({ error: "every document must be a sha256 digest" }, 400);
  if (!readers.every((r): r is string => typeof r === "string" && READER.test(r)))
    return c.json({ error: "every reader must be a reader key" }, 400);
  if (documents.length * readers.length > READS_PER_REQUEST) {
    return c.json(
      {
        error: `${documents.length} documents by ${readers.length} readers is more than ${READS_PER_REQUEST} reads; ask in batches`,
      },
      400,
    );
  }

  const bucket = c.env.ARCHIVE;
  const keys = documents.flatMap((sha256) =>
    readers.map((reader) => partKey.reading(sha256, reader)),
  );
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for (let i = 0; i < keys.length; i += READS_AT_ONCE) {
          const batch = await Promise.all(
            keys.slice(i, i + READS_AT_ONCE).map(async (key) => (await bucket.get(key))?.text()),
          );
          // A document nobody has read yet is simply absent. The caller counts what came back
          // against what it asked for, and reports the rest as pending.
          for (const read of batch) {
            const line = read?.replace(/\n+$/, "");
            if (line) controller.enqueue(encoder.encode(`${line}\n`));
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
});

controlRoutes.post("/classify", async (c) => {
  const sellerId = c.req.query("seller");
  const checkedAt = c.req.query("date");
  if (!sellerId || !checkedAt) return c.json({ error: "seller and date required" }, 400);
  return c.json(await classifyRun(c.env, sellerId, checkedAt));
});

controlRoutes.post("/maker", async (c) => {
  const manufacturerId = c.req.query("id");
  const domains = (c.req.query("domains") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (!manufacturerId || domains.length === 0)
    return c.json({ error: "id and domains required" }, 400);
  const pages = c.req.query("pages");
  const run = newRun();
  const id = `maker-${manufacturerId}-${run.id}`;
  const instance = await c.env.MANUFACTURER_CRAWL.create({
    id,
    params: {
      instanceId: id,
      run: run.id,
      manufacturerId,
      domains,
      checkedAt: run.date,
      ...(pages ? { pageLimit: Number(pages) } : {}),
    },
  });
  return c.json({ id: instance.id });
});

controlRoutes.post("/convert", async (c) => {
  const manufacturerId = c.req.query("id");
  const checkedAt = c.req.query("date");
  if (!manufacturerId || !checkedAt) return c.json({ error: "id and date required" }, 400);
  // Reading follows conversion on its own: each converted document enqueues its own reading.
  return c.json(await convertRun(c.env, manufacturerId, checkedAt));
});

// The supervisor does this every day for whatever converted since it last looked; this is for not
// waiting until tomorrow. A document with a text layer is looked up and left alone.
controlRoutes.post("/vision", async (c) => {
  const manufacturerId = c.req.query("id");
  const checkedAt = c.req.query("date");
  if (!manufacturerId || !checkedAt) return c.json({ error: "id and date required" }, 400);
  // An offer is what a pass makes, so it waits for the lease a pass holds: offered by both, a
  // maker's pages would be queued and read twice.
  try {
    return c.json(
      await underLease(c.env.ARCHIVE, () => visionRun(c.env, manufacturerId, checkedAt), {
        what: "offer",
        ms: OFFER_LEASE_MS,
      }),
    );
  } catch (error) {
    const held = leaseHeld(error);
    if (held) return c.json(held, 409);
    throw error;
  }
});

// One call rather than eighty-six. Discovery only reads pages a maker already publishes to search
// engines, so it needs no approval; the download after it still does.
controlRoutes.post("/discover-all", async (c) => {
  const checkedAt = c.req.query("date") ?? today();
  const pages = Number(c.req.query("pages") ?? "150");
  const started: string[] = [];
  for (const maker of manufacturers) {
    const run = newRun();
    const id = `maker-${maker.id}-${run.id}`;
    await c.env.MANUFACTURER_CRAWL.create({
      id,
      params: {
        instanceId: id,
        run: run.id,
        manufacturerId: maker.id,
        domains: maker.domains,
        checkedAt: run.date,
        pageLimit: pages,
      },
    });
    started.push(maker.id);
  }
  return c.json({ started: started.length, checkedAt });
});

controlRoutes.post("/spec-pages", async (c) => {
  const manufacturerId = c.req.query("id");
  const checkedAt = c.req.query("date");
  if (!manufacturerId || !checkedAt) return c.json({ error: "id and date required" }, 400);
  return c.json(await specPagesRun(c.env, manufacturerId, checkedAt, specPages.pages));
});

controlRoutes.post("/approve", async (c) => {
  // A caller names the maker and the day; which instance is waiting is the run's business.
  const named = c.req.query("maker");
  const id = named ? await currentInstance(c.env, named) : c.req.query("id");
  if (!id)
    return c.json({ error: named ? `no run recorded for ${named}` : "id or maker required" }, 400);
  // The approver is whoever GitHub says is signed in, not a name the request carries. Only local
  // development has the control token, and nobody is vouched for there.
  const caller = c.get("caller");
  const approvedBy =
    caller.kind === "member"
      ? caller.login
      : caller.kind === "workflow"
        ? `${caller.workflow} run ${caller.runId}`
        : "the control token";
  const asked: unknown = await c.req.json().catch(() => null);
  const parsed = CrawlApproval.safeParse(
    asked !== null && typeof asked === "object" ? { ...asked, approvedBy } : asked,
  );
  if (!parsed.success)
    return c.json({ error: "approval must say approved", detail: parsed.error.issues }, 400);
  const instance = await c.env.MANUFACTURER_CRAWL.get(id);
  await instance.sendEvent({ type: APPROVAL_EVENT, payload: parsed.data });
  return c.json({ sent: parsed.data.approved, to: id });
});

/** The workflow an instance belongs to, told by the prefix it was created with. */
function workflowOf(env: Env, id: string): Workflow {
  return id.startsWith("page-")
    ? env.PAGE_CRAWL
    : id.startsWith("maker-")
      ? env.MANUFACTURER_CRAWL
      : env.SELLER_CRAWL;
}

controlRoutes.get("/status", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required" }, 400);
  const instance = await workflowOf(c.env, id).get(id);
  const status = await instance.status();
  return c.json({ status: status.status, error: status.error ?? null });
});

/** Instances asked about at once. Each is a call to the Workflows service. */
const STATUSES_AT_ONCE = 8;

/**
 * The workflow behind every current run, and where it is. A binding can fetch an instance by id
 * and cannot list them, so this reads the ids the runs recorded on their pointers.
 */
controlRoutes.get("/runs", async (c) => {
  const [makers, sellers] = await Promise.all([
    currentRuns(c.env.ARCHIVE, "documents"),
    currentRuns(c.env.ARCHIVE, "sightings"),
  ]);
  const current = [
    ...makers.map((run) => ({ kind: "maker" as const, ...run })),
    ...sellers.map((run) => ({ kind: "seller" as const, ...run })),
  ].flatMap(({ kind, entity, pointer }) =>
    pointer.instance ? [{ kind, entity, pointer, instance: pointer.instance }] : [],
  );
  const runs = [];
  for (let i = 0; i < current.length; i += STATUSES_AT_ONCE) {
    const batch = current.slice(i, i + STATUSES_AT_ONCE).map(async (run) => {
      const described = {
        kind: run.kind,
        entity: run.entity,
        run: run.pointer.run,
        date: run.pointer.date,
        instance: run.instance,
      };
      try {
        const status = await (await workflowOf(c.env, run.instance).get(run.instance)).status();
        return { ...described, status: status.status, error: status.error?.message ?? null };
      } catch (error) {
        // An instance past the Workflows retention, or one recorded under the wrong id, is not
        // there to ask. That is worth showing, not a reason to fail the whole list.
        return {
          ...described,
          status: "unknown",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    runs.push(...(await Promise.all(batch)));
  }
  return c.json({ runs });
});

/** What the supervisor did on its last pass, and what it could not do. */
controlRoutes.get("/supervision", async (c) => {
  const report = await c.env.ARCHIVE.get("supervision/latest.json");
  if (!report) return c.json({ error: "the supervisor has not reported yet" }, 404);
  return new Response(report.body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
});

/**
 * Pages for members of the working group. Somebody not signed in is sent to sign in rather than
 * shown an error, and somebody signed in who is not a member is told why.
 */
export const memberPages: App = new Hono<{ Bindings: Env }>();

memberPages.get("/ops", async (c) => {
  const who = await identify(c);
  if (!who.ok)
    return who.status === 401
      ? c.redirect(`/auth/login?next=${encodeURIComponent("/ops")}`, 302)
      : c.text(who.error, who.status);
  // The page is built into the asset store with the site. It is fetched from there by this route
  // rather than served by it, so it reaches nobody the check above turned away; the store answers
  // `/ops.html` with a redirect back here.
  const page = await c.env.SITE.fetch(new Request(new URL("/ops", c.req.url)));
  const served = new Response(page.body, page);
  served.headers.set("cache-control", "private, no-store");
  return served;
});

/**
 * What a workflow on main writes. No person and no shared secret reaches these: each route names
 * the one workflow file it accepts, and the caller proves it is that workflow with a token GitHub
 * signed for the job. The control token is not accepted, so holding it does not let anyone publish.
 */
export const workflowRoutes: App = new Hono<{ Bindings: Env }>();

/** Every route a workflow calls, and the one workflow file each accepts. */
export const WORKFLOW_ROUTES: readonly { method: "PUT"; path: string; rule: WorkflowRule }[] = [
  {
    method: "PUT",
    path: "/v1/:file",
    rule: {
      workflow: "publish.yml",
      events: ["push", "workflow_dispatch"],
      environment: PRODUCTION,
    },
  },
];

// On the method as well as the path: GET on the same path is public, and must stay so.
for (const route of WORKFLOW_ROUTES) {
  workflowRoutes.on(route.method, route.path, async (c, next) => {
    const token = bearer(c.req.raw);
    let check: WorkflowCheck;
    try {
      check = token
        ? await verifyWorkflow(token, route.rule)
        : { ok: false, reason: `a GitHub Actions token from ${route.rule.workflow} is required` };
    } catch (error) {
      if (error instanceof GitHubKeysUnavailable) return c.json({ error: error.message }, 503);
      throw error;
    }
    if (!check.ok) return c.json({ error: check.reason }, 401);
    logWorkflowCall(route.method, new URL(c.req.url).pathname, check.job);
    await next();
  });
}

const MANIFEST = "manifest.json";
/** The manifest is a few kilobytes. A body far past that is not one. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** The part of the build's manifest the front door quotes back: each file's size and digest. */
const DatasetManifest = z.object({
  files: z.record(
    z
      .string()
      .refine((name) => name !== MANIFEST && DATASET_PATH.test(`/v1/${name}`), "not a table name"),
    z.object({
      rows: z.number().int().nonnegative().optional(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(SHA256),
    }),
  ),
});

/**
 * Publish one file of the dataset, or, last, the manifest that describes them.
 *
 * A file declares its sha256 and R2 checks the body against it as it is written. The manifest is
 * written only when every file it names is stored at the size and digest it states: the manifest
 * is what the front door quotes, and a hash there that disagrees with the file served is the
 * index describing a file that is not there.
 */
workflowRoutes.put("/v1/:file", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!DATASET_PATH.test(path)) return c.json({ error: "not a dataset file" }, 404);
  const name = path.slice("/v1/".length);
  return name === MANIFEST ? putManifest(c) : putFile(c, name);
});

async function putFile(c: Context<{ Bindings: Env }>, name: string): Promise<Response> {
  const sha256 = c.req.header("x-content-sha256");
  if (!sha256 || !SHA256.test(sha256))
    return c.json({ error: "x-content-sha256 must be the file's sha256, in hex" }, 400);
  // R2 has to know a streamed body's length before it starts writing it.
  const length = Number(c.req.header("content-length"));
  const body = c.req.raw.body;
  if (!body || !Number.isSafeInteger(length) || length <= 0)
    return c.json({ error: "the file must be sent with its content-length" }, 411);
  try {
    const object = await c.env.ARCHIVE.put(datasetKey(name), body, {
      sha256,
      httpMetadata: { contentType: datasetType(name) },
    });
    return c.json({ file: name, bytes: object.size, sha256 });
  } catch (error) {
    // R2 refuses a body whose digest is not the declared one, and the object already there stays.
    // 10037 is R2's code for that. Anything else is not the caller's to fix.
    if (error instanceof Error && error.message.endsWith("(10037)"))
      return c.json({ error: `${name} is not the file whose sha256 was declared` }, 422);
    throw error;
  }
}

async function putManifest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const length = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0)
    return c.json({ error: "the manifest must be sent with its content-length" }, 411);
  if (length > MANIFEST_MAX_BYTES)
    return c.json(
      { error: `a manifest is under ${MANIFEST_MAX_BYTES} bytes; this is ${length}` },
      413,
    );
  const text = await c.req.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return c.json({ error: "the manifest is not JSON" }, 400);
  }
  const parsed = DatasetManifest.safeParse(json);
  if (!parsed.success)
    return c.json({ error: "not a dataset manifest", detail: parsed.error.issues }, 400);
  const files = Object.entries(parsed.data.files);
  if (files.length === 0)
    return c.json({ error: "a manifest that names no files would unpublish the dataset" }, 400);

  const disagree: string[] = [];
  for (const [name, meta] of files) {
    const stored = await c.env.ARCHIVE.head(datasetKey(name));
    const sha256 = stored?.checksums.toJSON().sha256;
    if (!stored) disagree.push(`${name}: not uploaded`);
    else if (stored.size !== meta.bytes)
      disagree.push(`${name}: ${stored.size} bytes stored, the manifest says ${meta.bytes}`);
    else if (sha256 !== meta.sha256)
      disagree.push(
        `${name}: stored sha256 is ${sha256 ?? "unrecorded"}, the manifest says ${meta.sha256}`,
      );
  }
  if (disagree.length > 0)
    return c.json({ error: "the manifest does not describe what is stored", files: disagree }, 409);

  await c.env.ARCHIVE.put(datasetKey(MANIFEST), text, {
    httpMetadata: { contentType: datasetType(MANIFEST) },
  });
  return c.json({ file: MANIFEST, files: files.length });
}

/**
 * The whole surface. Public and sign-in first, then everything else behind sign-in, so a path
 * that matches no public route falls through to a handler that demands a member — the safe
 * direction to fail in. Workflow routes last: they answer only the methods they name.
 */
export const app: App = new Hono<{ Bindings: Env }>();
app.route("/", publicRoutes);
app.route("/", authRoutes);
app.route("/", memberPages);
app.route("/", controlRoutes);
app.route("/", workflowRoutes);
// Whatever is left is the site's: its stylesheet, its scripts, its own 404. A path that is neither
// the Worker's nor a file it holds gets the site's answer, not a bare JSON error.
app.notFound(async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "not found" }, 404);
  return c.env.SITE.fetch(c.req.raw);
});

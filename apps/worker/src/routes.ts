import { ActivityQuery } from "@origin89/equipment-schema/activity";
import { APPROVAL_EVENT, CrawlApproval } from "@origin89/equipment-schema/documents";
import { READS_PER_REQUEST, readerKey } from "@origin89/equipment-schema/provenance";
import {
  CompareQuery,
  canonical,
  isLoadPart,
  isSnapshotPart,
  LOAD_PART_MAX,
  LOAD_PART_ROWS,
  LoadPlan,
  type Publication,
  RecordKind,
  SNAPSHOT_PART_MAX,
  SNAPSHOT_PART_ROWS,
  SnapshotPlan,
  snapshotName,
  snapshotPartName,
} from "@origin89/equipment-schema/releases";
import { type Context, Hono } from "hono";
import { z } from "zod";
import specPages from "../../../feeds/spec-pages.json" with { type: "json" };
import { activityPage, actor, digest } from "./activity.ts";
import { bearer } from "./authorised.ts";
import {
  BadStart,
  classifyRun,
  convertRun,
  forgetReadings,
  NothingApproved,
  RunMoved,
  specPagesRun,
  visionRun,
} from "./enqueue.ts";
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
import { loadInstanceId, prepareStore, reloadInstanceId } from "./release-load.ts";
import { newestRelease } from "./release-store.ts";
import {
  compareReleases,
  HistoryUnavailable,
  indexRelease,
  loadKey,
  releasePage,
  saveRelease,
  snapshotKey,
} from "./releases.ts";
import {
  ARCHIVE_ROOTS,
  currentRuns,
  DATASET_PATH,
  datasetKey,
  datasetType,
  LOGO_PATH,
  pointerKey,
  readable,
  readPointer,
} from "./runs.ts";
import { sellers } from "./sellers.ts";
import {
  authRoutes,
  type Caller,
  type Identified,
  identify,
  localControlToken,
} from "./sign-in.ts";
import { TABLE_READER } from "./spec-table.ts";
import {
  RunConflict,
  RunStartUncertain,
  startIfFree,
  startMaker,
  startSeller,
  workflowOf,
} from "./start-run.ts";
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
        files?: Record<string, { rows?: number; bytes: number; sha256: string }>;
        load?: unknown;
        snapshots?: unknown;
      }>()
    : undefined;
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      name: "offgrid-equipment",
      // 2: the Worker loads each release into the store behind the API; a publisher on 1 would
      // publish parts nothing loads. 3: record snapshots come in parts; a Worker on 2 would keep
      // them as plain files and record releases nothing can compare. 4: `/publication` says what
      // is already published, so the publisher sends a dataset only when something lacks it.
      publication: { historyVersion: 4 },
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
      // Which load parts make each table, in order, and the column that keys it: what a reader of
      // the NDJSON needs and the file list alone does not say.
      ...(published?.load ? { load: published.load } : {}),
      // Which snapshot parts hold each record kind, in id order, now that a kind is no one file.
      ...(published?.snapshots ? { snapshots: published.snapshots } : {}),
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

/** The kind of a whole record snapshot, as releases wrote one before snapshots had parts. */
const wholeSnapshot = (name: string) =>
  RecordKind.options.find((kind) => snapshotName(kind) === name);
const inParts = (kind: z.infer<typeof RecordKind>) =>
  `record snapshots are published in parts, ${snapshotPartName(kind, 1)} and on`;

publicRoutes.on(["GET", "HEAD"], "/v1/:file", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!DATASET_PATH.test(path)) return c.notFound();
  const name = path.slice("/v1/".length);
  // Nothing publishes a whole snapshot any more, so the copy the last one left would be served
  // stale for as long as it stays in the bucket.
  const whole = wholeSnapshot(name);
  if (whole) return c.text(inParts(whole), 404);
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
  "/activity",
  "/releases",
  "/release-compare",
  "/approve",
  "/archive",
  "/classify",
  "/convert",
  "/discover-all",
  "/forget",
  "/maker",
  "/readings",
  "/run",
  "/runs",
  "/spec-pages",
  "/load",
  "/publication",
  "/state",
  "/status",
  "/supervise",
  "/supervision",
  "/vision",
] as const;

type ControlPath = (typeof CONTROL_PATHS)[number];

/** The job that publishes the dataset: publish.yml on main, in the production environment. */
const PUBLISH_JOB: WorkflowRule = {
  workflow: "publish.yml",
  events: ["schedule", "workflow_dispatch", "workflow_run"],
  environment: PRODUCTION,
};

/**
 * The workflows that call control routes, and the routes each may call. The pull and the
 * supervisor do not deploy, so neither needs the production environment, and the daily pull
 * starts on a schedule. The publisher only asks what is already published.
 */
export const CONTROL_WORKFLOWS: readonly (WorkflowRule & { paths: readonly ControlPath[] })[] = [
  { ...PUBLISH_JOB, paths: ["/publication"] },
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

controlRoutes.get("/activity", async (c) => {
  const query = ActivityQuery.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "Invalid activity filters" }, 400);
  return c.json(await activityPage(c.env.ARCHIVE, query.data));
});
controlRoutes.get("/releases", async (c) => {
  const cursor = c.req.query("cursor");
  if (cursor && cursor.length > 4096) return c.json({ error: "Invalid release cursor" }, 400);
  try {
    return c.json(await releasePage(c.env.ARCHIVE, cursor));
  } catch (error) {
    if (error instanceof HistoryUnavailable) return c.json({ error: error.message }, 409);
    throw error;
  }
});
controlRoutes.get("/release-compare", async (c) => {
  const query = CompareQuery.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "Choose valid versions and comparison filters" }, 400);
  try {
    const result = await compareReleases(c.env.ARCHIVE, query.data);
    const body = JSON.stringify(result);
    if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024)
      return c.json(
        {
          error:
            "This comparison page is too large. Narrow the record ID filter or use the source comparison.",
        },
        413,
      );
    return c.body(body, 200, { "content-type": "application/json" });
  } catch (error) {
    if (error instanceof HistoryUnavailable) return c.json({ error: error.message }, 409);
    throw error;
  }
});

controlRoutes.post("/run", async (c) => {
  const sellerId = c.req.query("seller");
  const seller = sellers.find((s) => s.id === sellerId);
  if (!sellerId || !seller) return c.json({ error: "unknown seller" }, 400);
  const limit = Number(c.req.query("limit") ?? "120");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    return c.json({ error: "limit must be an integer from 1 to 500" }, 400);
  const tier = hasFeed(seller) ? "feed" : "page";
  try {
    const result = await startSeller(c.env, sellerId, tier, limit, actor(c.get("caller")));
    return c.json({ ...result, tier });
  } catch (error) {
    if (error instanceof RunConflict) return c.json({ error: error.message }, 409);
    if (error instanceof RunStartUncertain) return c.json({ error: error.message }, 503);
    throw error;
  }
});

// What the spider knows and what it is waiting on, read out of the archive rather than kept
// beside it. A weekly cron can lose a dozen crawls and nothing would say so otherwise.
/** A pass already running is an answer the caller can read, not a server error. */
const leaseHeld = (error: unknown): { error: string } | undefined =>
  error instanceof LeaseHeld ? { error: error.message } : undefined;

controlRoutes.post("/supervise", async (c) => {
  try {
    return c.json(await supervise(c.env, c.req.query("date") ?? today(), actor(c.get("caller"))));
  } catch (error) {
    const held = leaseHeld(error);
    if (held) return c.json(held, 409);
    throw error;
  }
});

// Put a release into the store behind the API, or put it back after the store was recreated for
// a schema change. Loading reads R2 and writes D1; nothing is fetched, spent or published.
controlRoutes.post("/load", async (c) => {
  const release = c.req.query("release");
  if (!release || !/^[a-f0-9]{64}$/.test(release))
    return c.json({ error: "release must be a release id, 64 hex characters" }, 400);
  try {
    const id = reloadInstanceId(release);
    await c.env.RELEASE_LOAD.create({ id, params: { release } });
    return c.json({ release, load: "started", instance: id });
  } catch (error) {
    if (error instanceof Error && /already exists|instance\.already/i.test(error.message))
      return c.json({ release, load: "already" }, 409);
    throw error;
  }
});

// Before a publication: the manifest the front door serves whole, and the newest release the store
// behind the API holds or is loading. A load writes every row again, so the publisher skips a
// dataset both already have. A store on an older schema is recreated here, as by any reader, and
// then holds nothing.
controlRoutes.get("/publication", async (c) => {
  const manifest = await servedManifest(c.env.ARCHIVE);
  await prepareStore(c.env.ARCHIVE, c.env.RELEASES);
  const publication: Publication = { manifest, release: await newestRelease(c.env.RELEASES) };
  return c.json(publication);
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
/** Readers given a document's bytes and nothing else, whose readings are the same for every maker. */
const PARSERS: ReadonlySet<string> = new Set([readerKey(TABLE_READER)]);

/**
 * Every reading of the documents asked for, in one response.
 *
 * A reading is addressed by the bytes it read, so a maker's readings are scattered across a flat
 * prefix with nothing to stream by, and asking for them one at a time cost a round trip each:
 * four thousand documents across three readers is thirteen thousand round trips, and the nightly
 * pull was heading past its hour. The caller already holds the document list, so it says which
 * ones it wants and the reads happen next to the bucket.
 *
 * A prompted reader reads a document for a maker, so the caller names the maker too, and gets that
 * maker's readings. A parser's are the same for every maker.
 */
controlRoutes.post("/readings", async (c) => {
  const asked = await c.req
    .json<{ maker?: unknown; documents?: unknown; readers?: unknown }>()
    .catch(() => undefined);
  const maker = manufacturers.find((m) => m.id === asked?.maker)?.id;
  const documents = Array.isArray(asked?.documents) ? asked.documents : [];
  const readers = Array.isArray(asked?.readers) ? asked.readers : [];
  if (!maker) return c.json({ error: "a known maker required" }, 400);
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
    readers.map((reader) =>
      PARSERS.has(reader) ? partKey.parsed(sha256, reader) : partKey.reading(sha256, maker, reader),
    ),
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
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(manufacturerId) ||
    domains.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))
  )
    return c.json({ error: "use a maker ID and bare domain names" }, 400);
  const maker = manufacturers.find((item) => item.id === manufacturerId);
  if (!maker) return c.json({ error: "unknown manufacturer" }, 400);
  if (domains.some((domain) => !maker.domains.includes(domain)))
    return c.json(
      { error: `Use the configured domains for ${manufacturerId}: ${maker.domains.join(", ")}.` },
      400,
    );
  const pages = c.req.query("pages");
  if (
    pages !== undefined &&
    (!Number.isSafeInteger(Number(pages)) || Number(pages) < 1 || Number(pages) > 500)
  )
    return c.json({ error: "pages must be an integer from 1 to 500" }, 400);
  try {
    return c.json(
      await startMaker(
        c.env,
        manufacturerId,
        domains,
        pages ? Number(pages) : undefined,
        actor(c.get("caller")),
      ),
    );
  } catch (error) {
    if (error instanceof RunConflict) return c.json({ error: error.message }, 409);
    if (error instanceof RunStartUncertain) return c.json({ error: error.message }, 503);
    throw error;
  }
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
/**
 * Forget a maker's prompted readings so the next convert reads its documents again. `dry` is
 * true unless it says `false`: counting is free, and what this removes was paid for.
 */
controlRoutes.post("/forget", async (c) => {
  const manufacturerId = c.req.query("id");
  if (!manufacturerId) return c.json({ error: "id required" }, 400);
  const dry = c.req.query("dry") !== "false";
  const from = Number(c.req.query("from") ?? 0);
  if (!Number.isSafeInteger(from) || from < 0)
    return c.json({ error: "from must be a count" }, 400);
  // An empty run is no run named: the first batch has none to name yet.
  const run = c.req.query("run") || undefined;
  // Only what the caller can put right is answered with a 4xx; a bucket or a manifest that fails
  // mid-batch is a 500, so a batch that removed some readings and stopped is not reported as done.
  try {
    return c.json(await forgetReadings(c.env, manufacturerId, dry, from, run));
  } catch (error) {
    if (error instanceof RunMoved) return c.json({ error: error.message }, 409);
    if (error instanceof BadStart) return c.json({ error: error.message }, 400);
    if (error instanceof NothingApproved) return c.json({ error: error.message }, 404);
    throw error;
  }
});

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
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500)
    return c.json({ error: "pages must be an integer from 1 to 500" }, 400);
  const started: string[] = [];
  const skipped: string[] = [];
  for (const maker of manufacturers) {
    const id = await startIfFree(() =>
      startMaker(c.env, maker.id, maker.domains, pages, actor(c.get("caller"))),
    );
    (id ? started : skipped).push(maker.id);
  }
  return c.json({ started: started.length, skipped, checkedAt });
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

memberPages.get("/ops/*", async (c) => {
  const who = await identify(c);
  if (!who.ok)
    return who.status === 401
      ? c.redirect(
          `/auth/login?next=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`,
          302,
        )
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
type PublicationEnv = { Bindings: Env; Variables: { job: Job } };
export const workflowRoutes = new Hono<PublicationEnv>();

/** Every route a workflow calls, and the one workflow file each accepts. */
export const WORKFLOW_ROUTES: readonly { method: "PUT"; path: string; rule: WorkflowRule }[] = [
  {
    method: "PUT",
    path: "/v1/:file",
    rule: PUBLISH_JOB,
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
    c.set("job", check.job);
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
  files: z
    .record(
      z
        .string()
        .refine(
          (name) => name !== MANIFEST && DATASET_PATH.test(`/v1/${name}`),
          "not a table name",
        ),
      z.object({
        rows: z.number().int().nonnegative().optional(),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(SHA256),
      }),
    )
    .refine((files) => Object.keys(files).length <= 256, "too many dataset files"),
  load: LoadPlan.optional(),
  snapshots: SnapshotPlan.optional(),
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

/**
 * Records in an NDJSON body: one a non-empty line, each a JSON object, at most `LOAD_PART_ROWS`
 * of them. A line that is not an object, or a part over the bound, is refused with the line
 * named, so nothing is stored that a loader would choke on.
 */
export function ndjsonRows(bytes: Uint8Array): number {
  let text: string;
  try {
    // Strict: a byte sequence that is not UTF-8 is refused rather than stored with replacements.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new RangeError("not UTF-8");
  }
  const lines = text.split("\n");
  let rows = 0;
  for (const [at, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new RangeError(`line ${at + 1} is not JSON`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new RangeError(`line ${at + 1} is not a JSON object`);
    rows += 1;
    if (rows > LOAD_PART_ROWS) throw new RangeError(`more than ${LOAD_PART_ROWS} records`);
  }
  return rows;
}

/**
 * The records in a snapshot part: a JSON array of objects, each with an id, in id order, at least
 * one and at most `SNAPSHOT_PART_ROWS` of them. Anything else is refused, so a comparison never
 * meets a part it cannot walk.
 */
export function snapshotRows(bytes: Uint8Array): number {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new RangeError("not UTF-8 JSON");
  }
  if (!Array.isArray(value)) throw new RangeError("not a JSON array");
  if (value.length === 0) throw new RangeError("no records");
  if (value.length > SNAPSHOT_PART_ROWS)
    throw new RangeError(`more than ${SNAPSHOT_PART_ROWS} records`);
  let last: string | undefined;
  for (const [at, record] of value.entries()) {
    const id: unknown =
      record !== null && typeof record === "object" && !Array.isArray(record)
        ? (record as { id?: unknown }).id
        : undefined;
    if (typeof id !== "string" || id === "")
      throw new RangeError(`record ${at + 1} is not an object with an id`);
    if (last !== undefined && !(last < id))
      throw new RangeError(`record ${at + 1}, ${id}, is out of id order`);
    last = id;
  }
  return value.length;
}

async function putFile(c: Context<PublicationEnv>, name: string): Promise<Response> {
  const sha256 = c.req.header("x-content-sha256");
  if (!sha256 || !SHA256.test(sha256))
    return c.json({ error: "x-content-sha256 must be the file's sha256, in hex" }, 400);
  // R2 has to know a streamed body's length before it starts writing it.
  const length = Number(c.req.header("content-length"));
  const body = c.req.raw.body;
  if (!body || !Number.isSafeInteger(length) || length <= 0)
    return c.json({ error: "the file must be sent with its content-length" }, 411);
  // A whole snapshot would be kept as a plain file, with no immutable copy for a comparison to read.
  const whole = wholeSnapshot(name);
  if (whole) return c.json({ error: inParts(whole) }, 400);
  const isSnapshot = isSnapshotPart(name);
  if (isSnapshot && length > SNAPSHOT_PART_MAX)
    return c.json({ error: "Record snapshot part is too large" }, 413);
  const isLoad = isLoadPart(name);
  if (isLoad && length > LOAD_PART_MAX) return c.json({ error: "Load part is too large" }, 413);
  try {
    // A snapshot or a load part is bounded and content-addressed before the mutable public copy
    // changes: a loader or a comparison reads the part by its hash, whatever was published since.
    const content = isSnapshot || isLoad ? new Uint8Array(await c.req.arrayBuffer()) : body;
    // A part's records are counted and checked as it is stored, so the manifest's count is held
    // against the bytes rather than repeated from the plan, and a malformed part is refused.
    let rows = 0;
    if ((isSnapshot || isLoad) && content instanceof Uint8Array) {
      try {
        rows = isSnapshot ? snapshotRows(content) : ndjsonRows(content);
      } catch (error) {
        if (error instanceof RangeError)
          return c.json(
            {
              error: `${name} is not a ${isSnapshot ? "snapshot" : "load"} part: ${error.message}`,
            },
            422,
          );
        throw error;
      }
    }
    if (isSnapshot)
      await c.env.ARCHIVE.put(snapshotKey(sha256), content, {
        sha256,
        httpMetadata: { contentType: "application/json" },
        customMetadata: { rows: String(rows) },
      });
    if (isLoad)
      await c.env.ARCHIVE.put(loadKey(sha256), content, {
        sha256,
        httpMetadata: { contentType: datasetType(name) },
        customMetadata: { rows: String(rows) },
      });
    const object = await c.env.ARCHIVE.put(datasetKey(name), content, {
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

/** Each file the front door serves that is not stored as the manifest names it. */
async function unlikeStored(
  bucket: R2Bucket,
  files: [string, z.infer<typeof DatasetManifest>["files"][string]][],
): Promise<string[]> {
  const disagree: string[] = [];
  for (const [name, meta] of files) {
    const stored = await bucket.head(datasetKey(name));
    const sha256 = stored?.checksums.toJSON().sha256;
    if (!stored) disagree.push(`${name}: not uploaded`);
    else if (stored.size !== meta.bytes)
      disagree.push(`${name}: ${stored.size} bytes stored, the manifest says ${meta.bytes}`);
    else if (sha256 !== meta.sha256)
      disagree.push(
        `${name}: stored sha256 is ${sha256 ?? "unrecorded"}, the manifest says ${meta.sha256}`,
      );
  }
  return disagree;
}

/**
 * The sha256 of the manifest the front door serves, when every file it names is stored as it
 * says. A publish that stopped partway leaves the old manifest over some newer files, and a
 * dataset matching that manifest still has to go up.
 */
async function servedManifest(bucket: R2Bucket): Promise<string | null> {
  const object = await bucket.get(datasetKey(MANIFEST));
  if (!object) return null;
  const text = await object.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = DatasetManifest.safeParse(json);
  if (!parsed.success) return null;
  const unlike = await unlikeStored(bucket, Object.entries(parsed.data.files));
  return unlike.length === 0 ? digest(text) : null;
}

async function putManifest(c: Context<PublicationEnv>): Promise<Response> {
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

  const disagree = await unlikeStored(c.env.ARCHIVE, files);
  for (const [name, meta] of files) {
    const kind = isLoadPart(name) ? "load" : isSnapshotPart(name) ? "snapshot" : undefined;
    if (!kind) continue;
    const part = await c.env.ARCHIVE.head(
      kind === "load" ? loadKey(meta.sha256) : snapshotKey(meta.sha256),
    );
    if (!part || part.size !== meta.bytes || part.checksums.toJSON().sha256 !== meta.sha256)
      disagree.push(`${name}: immutable ${kind} part is missing or inconsistent`);
    else if (meta.rows !== undefined && Number(part.customMetadata?.rows) !== meta.rows)
      disagree.push(
        `${name}: holds ${part.customMetadata?.rows ?? "an uncounted number of"} records, the manifest says ${meta.rows}`,
      );
  }
  // A load plan names parts the manifest lists, each named for its own table, each once, each
  // with a row count, adding up to the rows the plan states, or it is no plan.
  const assigned = new Set<string>();
  for (const [table, plan] of Object.entries(parsed.data.load?.tables ?? {})) {
    let rows = 0;
    for (const part of plan.parts) {
      const meta = parsed.data.files[part];
      if (!meta) disagree.push(`${table}: load part ${part} is not in the manifest`);
      else if (part.replace(/_\d{4}\.ndjson$/, "") !== table)
        disagree.push(`${table}: load part ${part} is named for another table`);
      else if (meta.rows === undefined)
        disagree.push(`${table}: load part ${part} states no row count`);
      else rows += meta.rows;
      if (assigned.has(part)) disagree.push(`${table}: load part ${part} is assigned twice`);
      assigned.add(part);
    }
    if (rows !== plan.rows)
      disagree.push(`${table}: its load parts hold ${rows} rows, the plan says ${plan.rows}`);
  }
  // And every part the manifest lists is in some table's plan: a plan that leaves a table out
  // would load a subset and call it the release.
  const partsListed = files.some(([name]) => isLoadPart(name));
  if (partsListed && !parsed.data.load)
    disagree.push("load parts are listed and no load plan says which table each makes");
  // Every table the manifest publishes as CSV is in the plan, with no parts when it has no rows:
  // a table left out of the plan altogether leaves no stray part to notice, so the tables are
  // checked from the CSV side too.
  if (parsed.data.load)
    for (const [name, meta] of files) {
      if (!name.endsWith(".csv")) continue;
      const table = name.slice(0, -".csv".length);
      const planned = parsed.data.load.tables[table];
      if (!planned) disagree.push(`${table}: published as a table and absent from the load plan`);
      else if (meta.rows !== undefined && planned.rows !== meta.rows)
        disagree.push(`${table}: the plan says ${planned.rows} rows, the table has ${meta.rows}`);
    }
  if (parsed.data.load)
    for (const [name, meta] of files) {
      if (!isLoadPart(name)) continue;
      if (!assigned.has(name)) disagree.push(`${name}: a load part in no table's plan`);
      if (meta.rows !== undefined && meta.rows > LOAD_PART_ROWS)
        disagree.push(`${name}: ${meta.rows} rows, over the ${LOAD_PART_ROWS} a part may hold`);
    }
  // A snapshot plan gives every record kind and no other, each kind's parts numbered from 1 and
  // listed in the manifest with a row count, adding up to the records the plan states; and every
  // snapshot part the manifest lists is in it. A kind missing a part would compare as a release
  // that dropped its records.
  const snapshotFiles = files.filter(([name]) => isSnapshotPart(name));
  const snapshots = parsed.data.snapshots;
  if (!snapshots && snapshotFiles.length > 0)
    disagree.push("snapshot parts are listed and no snapshot plan says which kind each holds");
  if (snapshots) {
    const planned = new Set<string>();
    for (const kind of Object.keys(snapshots.kinds))
      if (!RecordKind.safeParse(kind).success)
        disagree.push(`${kind}: in the snapshot plan and not a record kind`);
    for (const kind of RecordKind.options) {
      const plan = snapshots.kinds[kind];
      if (!plan) {
        disagree.push(`${kind}: absent from the snapshot plan`);
        continue;
      }
      let rows = 0;
      for (const [at, part] of plan.parts.entries()) {
        planned.add(part);
        const meta = parsed.data.files[part];
        if (part !== snapshotPartName(kind, at + 1))
          disagree.push(`${kind}: snapshot part ${at + 1} is named ${part}`);
        else if (!meta) disagree.push(`${kind}: snapshot part ${part} is not in the manifest`);
        else if (meta.rows === undefined)
          disagree.push(`${kind}: snapshot part ${part} states no row count`);
        else rows += meta.rows;
      }
      if (rows !== plan.rows)
        disagree.push(
          `${kind}: its snapshot parts hold ${rows} records, the plan says ${plan.rows}`,
        );
    }
    for (const [name] of snapshotFiles)
      if (!planned.has(name)) disagree.push(`${name}: a snapshot part in no kind's plan`);
  }
  if (disagree.length > 0)
    return c.json({ error: "the manifest does not describe what is stored", files: disagree }, 409);

  // The release is recorded and its load started before the public manifest changes: a failure
  // in either leaves the front door on the release it had, and the publisher's rerun is a new
  // attempt with its own record and load. A retry after a history failure repairs the same job
  // attempt's entry.
  const job = c.get("job");
  const release = await saveRelease(
    c.env.ARCHIVE,
    parsed.data.files,
    job.sha,
    job.runId,
    job.runAttempt,
    {
      ...(parsed.data.load ? { load: parsed.data.load } : {}),
      ...(parsed.data.snapshots ? { snapshots: parsed.data.snapshots } : {}),
    },
  );
  // A release record is immutable and named by its files and job attempt, not its plans: a retry
  // of one attempt that changes a plan would load or compare a record that carries the old one,
  // so it is refused and a new attempt is what carries a new plan.
  for (const [plan, what] of [
    ["load", "load"],
    ["snapshots", "snapshot"],
  ] as const)
    if (canonical(release[plan] ?? null) !== canonical(parsed.data[plan] ?? null))
      return c.json(
        {
          error: `this publication was already recorded with a different ${what} plan; a new job attempt carries a new plan`,
          release: release.id,
        },
        409,
      );
  // The store behind the API loads the release from its content-addressed parts (#83). One
  // instance per release: a retried manifest finds it already created and leaves it be.
  let load: "started" | "already" | "not started" = "not started";
  if (parsed.data.load) {
    try {
      await c.env.RELEASE_LOAD.create({
        id: loadInstanceId(release.id),
        params: { release: release.id },
      });
      load = "started";
    } catch (error) {
      if (!(error instanceof Error && /already exists|instance\.already/i.test(error.message)))
        throw error;
      load = "already";
    }
  }
  await c.env.ARCHIVE.put(datasetKey(MANIFEST), text, {
    httpMetadata: { contentType: datasetType(MANIFEST) },
  });
  // The history names the job only once its manifest is public.
  await indexRelease(c.env.ARCHIVE, release);
  return c.json({ file: MANIFEST, files: files.length, release: release.id, load });
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

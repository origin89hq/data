import { Hono } from "hono";
import { sellers } from "./sellers.ts";
import { hasFeed } from "./feeds.ts";
import { APPROVAL_EVENT, CrawlApproval } from "./documents.ts";
import { authorised } from "./authorised.ts";
import { classifyRun, convertRun, specPagesRun } from "./enqueue.ts";
import specPages from "../../feeds/spec-pages.json" with { type: "json" };
import { manufacturers } from "./manufacturers.ts";
import { makerStates, sellerStates } from "./state.ts";
import { ARCHIVE_ROOTS, DATASET_PATH, LOGO_PATH, datasetKey, datasetType, newRun, pointerKey, readPointer, readable } from "./runs.ts";
import { supervise } from "./supervise.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";

/**
 * Every route the Worker answers, split by who may call it.
 *
 * The split is the point. This was a chain of ifs with one `authorised` check partway down, so
 * whether a route was public depended on where somebody wrote it — above the check or below it.
 * A route added in the wrong place would have been silently open, and nothing would have said so.
 * Now `public` holds the three anyone may call and `control` holds the rest behind a middleware
 * that runs before any of its handlers, and a test walks both tables rather than a list of names.
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

publicRoutes.on(["GET", "HEAD"], "/", async (c) => {
  // A browser gets the site, a client gets the index. Same URL, because the thing a person wants to
  // read and the thing a program wants to parse describe the same dataset.
  if (c.req.header("accept")?.includes("text/html")) return c.env.SITE.fetch(c.req.raw);
  const manifest = await c.env.ARCHIVE.get(datasetKey("manifest.json"));
  const published = manifest ? await manifest.json<{ counts?: Record<string, number>; files?: Record<string, { rows: number; bytes: number; sha256: string }> }>() : undefined;
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      name: "offgrid-equipment",
      description: "Off-grid power equipment: manufacturers, models, rated figures and the protocols a controller can speak to them with.",
      licence: "MIT, for the tooling and the records alike",
      repository: "https://github.com/origin89hq/offgrid-equipment",
      contact: "hello@origin89.com",
      provenance: "Every figure names the document it came from, the page, and whether a model read it or a parser did.",
      logos: {
        note: "A maker's mark is a trademark, not part of the MIT grant. Served here to identify the maker; ask the maker for any other use.",
        url: `${origin}/logos/<manufacturer>-<width>.png`,
      },
      ...(published?.counts ? { counts: published.counts } : {}),
      files: Object.fromEntries(Object.entries(published?.files ?? {}).map(([name, meta]) => [name, { ...meta, url: `${origin}/v1/${name}` }])),
    },
    200,
    { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  );
});

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
  const object = await c.env.ARCHIVE.get(datasetKey(name), asked ? { range: c.req.raw.headers } : undefined);
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
      ...(part ? { "content-range": `bytes ${part.offset}-${part.offset + part.length - 1}/${object.size}` } : {}),
      // A build is reproducible and its bytes are pinned by the manifest, so a stale copy is a
      // wrong answer rather than an old one. Short, and revalidated.
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "access-control-allow-origin": "*",
      etag: `"${object.httpEtag.replaceAll(String.fromCharCode(34), "")}"`,
    },
  });
});

/** Everything that starts work or reads the archive. The token is checked before any handler. */
export const controlRoutes: App = new Hono<{ Bindings: Env }>();

/**
 * Every path that needs the token, named once.
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
  "/run",
  "/spec-pages",
  "/state",
  "/status",
  "/supervise",
] as const;

// Registered before the handlers, because Hono runs a path's middleware in the order it was added.
for (const path of CONTROL_PATHS) {
  controlRoutes.use(path, async (c, next) => {
    if (!(await authorised(c.req.raw, c.env.CONTROL_TOKEN))) {
      return c.json({ error: "a bearer token is required; set one with: wrangler secret put CONTROL_TOKEN" }, 401);
    }
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
    params: { sellerId, run: run.id, checkedAt: run.date, ...(limit ? { limit: Number(limit) } : {}) },
  });
  return c.json({ id: instance.id, tier: "page" });
});

// What the spider knows and what it is waiting on, read out of the archive rather than kept
// beside it. A weekly cron can lose a dozen crawls and nothing would say so otherwise.
controlRoutes.post("/supervise", async (c) => c.json(await supervise(c.env, c.req.query("date") ?? today())));

controlRoutes.get("/state", async (c) => {
  const [sellerState, makerState] = await Promise.all([sellerStates(c.env.ARCHIVE), makerStates(c.env.ARCHIVE)]);
  return c.json({ sellers: sellerState, makers: makerState });
});

// Reading a run back one object at a time meant spawning wrangler once per part, which took longer
// than producing the results. R2 can list and the Worker can stream, so a whole run comes back in
// one request.
controlRoutes.get("/archive", async (c) => {
  const prefix = c.req.query("prefix");
  if (!prefix || !readable(prefix)) {
    return c.json({ error: `prefix must start with one of ${ARCHIVE_ROOTS.map((r) => `${r}/`).join(", ")}` }, 400);
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

controlRoutes.post("/classify", async (c) => {
  const sellerId = c.req.query("seller");
  const checkedAt = c.req.query("date");
  if (!sellerId || !checkedAt) return c.json({ error: "seller and date required" }, 400);
  return c.json(await classifyRun(c.env, sellerId, checkedAt));
});

controlRoutes.post("/maker", async (c) => {
  const manufacturerId = c.req.query("id");
  const domains = (c.req.query("domains") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  if (!manufacturerId || domains.length === 0) return c.json({ error: "id and domains required" }, 400);
  const pages = c.req.query("pages");
  const run = newRun();
  const id = `maker-${manufacturerId}-${run.id}`;
  const instance = await c.env.MANUFACTURER_CRAWL.create({
    id,
    params: { instanceId: id, run: run.id, manufacturerId, domains, checkedAt: run.date, ...(pages ? { pageLimit: Number(pages) } : {}) },
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

// One call rather than eighty-six. Discovery only reads pages a maker already publishes to search
// engines, so it needs no approval; the download after it still does.
controlRoutes.post("/discover-all", async (c) => {
  const checkedAt = c.req.query("date") ?? today();
  const pages = Number(c.req.query("pages") ?? "150");
  const started: string[] = [];
  for (const maker of manufacturers) {
    const run = newRun();
    const id = `maker-${maker.id}-${run.id}`;
    await c.env.MANUFACTURER_CRAWL.create({ id, params: { instanceId: id, run: run.id, manufacturerId: maker.id, domains: maker.domains, checkedAt: run.date, pageLimit: pages } });
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
  if (!id) return c.json({ error: named ? `no run recorded for ${named}` : "id or maker required" }, 400);
  const parsed = CrawlApproval.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "approval must name approvedBy and approved", detail: parsed.error.issues }, 400);
  const instance = await c.env.MANUFACTURER_CRAWL.get(id);
  await instance.sendEvent({ type: APPROVAL_EVENT, payload: parsed.data });
  return c.json({ sent: parsed.data.approved, to: id });
});

controlRoutes.get("/status", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required" }, 400);
  const binding = id.startsWith("page-") ? c.env.PAGE_CRAWL : id.startsWith("maker-") ? c.env.MANUFACTURER_CRAWL : c.env.SELLER_CRAWL;
  const instance = await binding.get(id);
  const status = await instance.status();
  return c.json({ status: status.status, error: status.error ?? null });
});

/**
 * The whole surface. Public first, then everything else behind the token, so a path that matches
 * no public route falls through to a handler that demands one — the safe direction to fail in.
 */
export const app: App = new Hono<{ Bindings: Env }>();
app.route("/", publicRoutes);
app.route("/", controlRoutes);
// Whatever is left is the site's: its stylesheet, its scripts, its own 404. A path that is neither
// the Worker's nor a file it holds gets the site's answer, not a bare JSON error.
app.notFound(async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "not found" }, 404);
  return c.env.SITE.fetch(c.req.raw);
});

import { sellers } from "./sellers.ts";
import { hasFeed } from "./feeds.ts";
import { CrawlApproval } from "./documents.ts";
import { authorised } from "./authorised.ts";
import { APPROVAL_EVENT } from "./manufacturer-crawl.ts";
import { consume } from "./consumer.ts";
import { classifyRun, convertRun, specPagesRun } from "./enqueue.ts";
import specPages from "../../feeds/spec-pages.json" with { type: "json" };
import { manufacturers } from "./manufacturers.ts";
import { makerStates, sellerStates } from "./state.ts";
import { newRun, pointerKey, readPointer, ARCHIVE_ROOTS, DATASET_PATH, datasetKey, datasetType, LOGO_PATH, readable } from "./runs.ts";
import { supervise } from "./supervise.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";

export { SellerCrawl } from "./seller-crawl.ts";
export { PageCrawl } from "./page-crawl.ts";
export { ManufacturerCrawl } from "./manufacturer-crawl.ts";

/** Today as YYYY-MM-DD in UTC. Computed once per trigger and passed in, never inside a step. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Which instance owns a maker's current run, so a caller can approve without knowing an id. */
async function currentInstance(env: Env, manufacturerId: string): Promise<string | undefined> {
  return (await readPointer(env.ARCHIVE, pointerKey.documents(manufacturerId)))?.instance;
}

export default {
  /** `POST /run?seller=<id>` starts a crawl; `GET /status?id=<instance>` reports one. Local development and by-hand runs only; the cron is the real trigger. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The front door. A liveness check tells a caller nothing a DNS lookup would not, so the root
    // says what the dataset is, what licence it carries and where every table can be fetched.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      const manifest = await env.ARCHIVE.get(datasetKey("manifest.json"));
      const published = manifest ? await manifest.json<{ counts?: Record<string, number>; files?: Record<string, { rows: number; bytes: number; sha256: string }> }>() : undefined;
      const base = `${url.origin}/v1`;
      return Response.json(
        {
          name: "offgrid-equipment",
          description: "Off-grid power equipment: manufacturers, models, rated figures and the protocols a controller can speak to them with.",
          licence: "MIT, for the tooling and the records alike",
          repository: "https://github.com/origin89hq/offgrid-equipment",
          contact: "hello@origin89.com",
          // A figure carries where it was read and how, so anybody can disagree with it.
          provenance: "Every figure names the document it came from, the page, and whether a model read it or a parser did.",
          logos: {
            note: "A maker's mark is a trademark, not part of the MIT grant. Served here to identify the maker; ask the maker for any other use.",
            url: `${url.origin}/logos/<manufacturer>-<width>.png`,
          },
          ...(published?.counts ? { counts: published.counts } : {}),
          files: Object.fromEntries(Object.entries(published?.files ?? {}).map(([name, meta]) => [name, { ...meta, url: `${base}/${name}` }])),
        },
        { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
      );
    }
    // A maker's logo is served to anyone, because a page that shows the catalogue has to render it
    // and a token in a browser is a token published. Only these keys, only GET, and nothing else in
    // the archive is reachable this way.
    if ((request.method === "GET" || request.method === "HEAD") && LOGO_PATH.test(url.pathname)) {
      const object = await env.ARCHIVE.get(url.pathname.slice(1));
      if (!object) return new Response("no such logo", { status: 404 });
      // A HEAD asks the same question without the bytes, and a cache in front of this will use it.
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "content-type": "image/png",
          // Addressed by maker and width, and a maker's mark changes about never.
          "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
          "access-control-allow-origin": "*",
        },
      });
    }
    // The tables themselves. A dataset nobody can download is not published, and until now these
    // existed only in a build directory that git ignores.
    if ((request.method === "GET" || request.method === "HEAD") && DATASET_PATH.test(url.pathname)) {
      const name = url.pathname.slice("/v1/".length);
      const object = await env.ARCHIVE.get(datasetKey(name));
      if (!object) return new Response("no such file", { status: 404 });
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "content-type": datasetType(name),
          "content-length": String(object.size),
          // A build is reproducible and its bytes are pinned by the manifest, so a stale copy is a
          // wrong answer rather than an old one. Short, and revalidated.
          "cache-control": "public, max-age=300, stale-while-revalidate=3600",
          "access-control-allow-origin": "*",
          etag: `"${object.httpEtag.replaceAll(String.fromCharCode(34), "")}"`,
        },
      });
    }
    if (!(await authorised(request, env.CONTROL_TOKEN))) {
      return Response.json({ error: "a bearer token is required; set one with: wrangler secret put CONTROL_TOKEN" }, { status: 401 });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const sellerId = url.searchParams.get("seller");
      if (!sellerId || !sellers.some((s) => s.id === sellerId)) return Response.json({ error: "unknown seller" }, { status: 400 });
      const checkedAt = url.searchParams.get("date") ?? today();
      const seller = sellers.find((s) => s.id === sellerId);
      if (!seller) return Response.json({ error: "unknown seller" }, { status: 400 });
      if (hasFeed(seller)) {
        const run = newRun();
        const params: SellerCrawlParams = { sellerId, run: run.id, checkedAt: run.date };
        const instance = await env.SELLER_CRAWL.create({ id: run.id, params });
        return Response.json({ id: instance.id, tier: "feed" });
      }
      const limit = url.searchParams.get("limit");
      const run = newRun();
      const instance = await env.PAGE_CRAWL.create({ id: `page-${run.id}`, params: { sellerId, run: run.id, checkedAt: run.date, ...(limit ? { limit: Number(limit) } : {}) } });
      return Response.json({ id: instance.id, tier: "page" });
    }
    // Reading a run back one object at a time meant spawning wrangler once per part, which took
    // longer than producing the results. R2 can list and the Worker can stream, so a whole run
    // comes back in one request.
    // What the spider knows and what it is waiting on, read out of the archive rather than kept
    // beside it. A weekly cron can lose a dozen crawls and nothing would say so otherwise.
    if (request.method === "POST" && url.pathname === "/supervise") {
      return Response.json(await supervise(env, url.searchParams.get("date") ?? today()));
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const [sellers, makers] = await Promise.all([sellerStates(env.ARCHIVE), makerStates(env.ARCHIVE)]);
      return Response.json({ sellers, makers });
    }
    if (request.method === "GET" && url.pathname === "/archive") {
      const prefix = url.searchParams.get("prefix");
      if (!prefix || !readable(prefix)) {
        return Response.json({ error: `prefix must start with one of ${ARCHIVE_ROOTS.map((r) => `${r}/`).join(", ")}` }, { status: 400 });
      }
      if (url.searchParams.get("list") === "true") {
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
          for (const object of page.objects) keys.push(object.key);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return Response.json({ prefix, keys: keys.sort() });
      }
      // Each object separated by a newline, so a caller can split whatever the objects hold:
      // JSONL parts concatenate into JSONL, and JSON documents into one per line.
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let cursor: string | undefined;
          try {
            do {
              const page = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
              for (const listed of [...page.objects].sort((a, b) => a.key.localeCompare(b.key))) {
                const object = await env.ARCHIVE.get(listed.key);
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
    }
    if (request.method === "POST" && url.pathname === "/classify") {
      const sellerId = url.searchParams.get("seller");
      const checkedAt = url.searchParams.get("date");
      if (!sellerId || !checkedAt) return Response.json({ error: "seller and date required" }, { status: 400 });
      return Response.json(await classifyRun(env, sellerId, checkedAt));
    }
    if (request.method === "POST" && url.pathname === "/maker") {
      const manufacturerId = url.searchParams.get("id");
      const domains = (url.searchParams.get("domains") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
      if (!manufacturerId || domains.length === 0) return Response.json({ error: "id and domains required" }, { status: 400 });
      const checkedAt = url.searchParams.get("date") ?? today();
      const pages = url.searchParams.get("pages");
      const run = newRun();
      const id = `maker-${manufacturerId}-${run.id}`;
      const instance = await env.MANUFACTURER_CRAWL.create({ id, params: { instanceId: id, run: run.id, manufacturerId, domains, checkedAt: run.date, ...(pages ? { pageLimit: Number(pages) } : {}) } });
      return Response.json({ id: instance.id });
    }
    if (request.method === "POST" && url.pathname === "/convert") {
      const manufacturerId = url.searchParams.get("id");
      const checkedAt = url.searchParams.get("date");
      if (!manufacturerId || !checkedAt) return Response.json({ error: "id and date required" }, { status: 400 });
      // Reading follows conversion on its own: each converted document enqueues its own reading.
      return Response.json(await convertRun(env, manufacturerId, checkedAt));
    }
    // One call rather than eighty-six. Discovery only reads pages a maker already publishes to
    // search engines, so it needs no approval; the download after it still does.
    if (request.method === "POST" && url.pathname === "/discover-all") {
      const checkedAt = url.searchParams.get("date") ?? today();
      const pages = Number(url.searchParams.get("pages") ?? "150");
      const started: string[] = [];
      for (const maker of manufacturers) {
        const run = newRun();
        const id = `maker-${maker.id}-${run.id}`;
        await env.MANUFACTURER_CRAWL.create({ id, params: { instanceId: id, run: run.id, manufacturerId: maker.id, domains: maker.domains, checkedAt: run.date, pageLimit: pages } });
        started.push(maker.id);
      }
      return Response.json({ started: started.length, checkedAt });
    }
    if (request.method === "POST" && url.pathname === "/spec-pages") {
      const manufacturerId = url.searchParams.get("id");
      const checkedAt = url.searchParams.get("date");
      if (!manufacturerId || !checkedAt) return Response.json({ error: "id and date required" }, { status: 400 });
      return Response.json(await specPagesRun(env, manufacturerId, checkedAt, specPages.pages));
    }
    if (request.method === "POST" && url.pathname === "/approve") {
      // A caller names the maker and the day; which instance is waiting is the run's business.
      const named = url.searchParams.get("maker");
      const id = named ? await currentInstance(env, named) : url.searchParams.get("id");
      if (!id) return Response.json({ error: named ? `no run recorded for ${named}` : "id or maker required" }, { status: 400 });
      const parsed = CrawlApproval.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: "approval must name approvedBy and approved", detail: parsed.error.issues }, { status: 400 });
      const instance = await env.MANUFACTURER_CRAWL.get(id);
      await instance.sendEvent({ type: APPROVAL_EVENT, payload: parsed.data });
      return Response.json({ sent: parsed.data.approved, to: id });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const binding = id.startsWith("page-") ? env.PAGE_CRAWL : id.startsWith("maker-") ? env.MANUFACTURER_CRAWL : env.SELLER_CRAWL;
      const instance = await binding.get(id);
      const status = await instance.status();
      return Response.json({ status: status.status, error: status.error ?? null });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  /**
   * Weekly: one instance per seller. Listings rot faster than register maps, and slower than a day.
   * On the first of the month, discovery over every maker as well — a maker's own pages change on
   * the scale of a product launch, and re-reading them weekly would be asking a question whose
   * answer has not moved.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const checkedAt = today();
    if (new Date(controller.scheduledTime).getUTCDate() === 1) {
      for (const maker of manufacturers) {
        const run = newRun();
        const id = `maker-${maker.id}-${run.id}`;
        await env.MANUFACTURER_CRAWL.create({ id, params: { instanceId: id, run: run.id, manufacturerId: maker.id, domains: maker.domains, checkedAt: run.date, pageLimit: 150 } });
      }
    }
    // Every day: move anything whose precondition is met. The weekly crawl and the monthly
    // discovery below produce work; this is what carries it through the stages after them.
    await supervise(env, checkedAt);
    if (new Date(controller.scheduledTime).getUTCHours() === 8) return;
    for (const seller of sellers) {
      if (hasFeed(seller)) {
        const run = newRun();
        const params: SellerCrawlParams = { sellerId: seller.id, run: run.id, checkedAt: run.date };
        await env.SELLER_CRAWL.create({ id: run.id, params });
      } else {
        const run = newRun();
        await env.PAGE_CRAWL.create({ id: `page-${run.id}`, params: { sellerId: seller.id, run: run.id, checkedAt: run.date } });
      }
    }
  },
  /** Every unit of fan-out work. Acknowledged or retried per message, never per batch. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await consume(batch, env);
  },
} satisfies ExportedHandler<Env>;

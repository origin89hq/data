import { sellers } from "./sellers.ts";
import { hasFeed } from "./feeds.ts";
import { CrawlApproval } from "./documents.ts";
import { authorised } from "./authorised.ts";
import { APPROVAL_EVENT } from "./manufacturer-crawl.ts";
import { consume } from "./consumer.ts";
import { classifyRun, convertRun } from "./enqueue.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";

export { SellerCrawl } from "./seller-crawl.ts";
export { PageCrawl } from "./page-crawl.ts";
export { ManufacturerCrawl } from "./manufacturer-crawl.ts";

/** Today as YYYY-MM-DD in UTC. Computed once per trigger and passed in, never inside a step. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A deterministic instance id: one crawl per seller per day, and a second trigger the same day is refused as a duplicate rather than run twice. */
function instanceId(sellerId: string, checkedAt: string): string {
  return `${sellerId}-${checkedAt}`;
}

export default {
  /** `POST /run?seller=<id>` starts a crawl; `GET /status?id=<instance>` reports one. Local development and by-hand runs only; the cron is the real trigger. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // A liveness check tells a caller nothing it could not learn from a DNS lookup.
    if (request.method === "GET" && url.pathname === "/") return Response.json({ ok: true });
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
        const params: SellerCrawlParams = { sellerId, checkedAt };
        const instance = await env.SELLER_CRAWL.create({ id: instanceId(sellerId, checkedAt), params });
        return Response.json({ id: instance.id, tier: "feed" });
      }
      const limit = url.searchParams.get("limit");
      const instance = await env.PAGE_CRAWL.create({ id: `page-${instanceId(sellerId, checkedAt)}`, params: { sellerId, checkedAt, ...(limit ? { limit: Number(limit) } : {}) } });
      return Response.json({ id: instance.id, tier: "page" });
    }
    // Reading a run back one object at a time meant spawning wrangler once per part, which took
    // longer than producing the results. R2 can list and the Worker can stream, so a whole run
    // comes back in one request.
    if (request.method === "GET" && url.pathname === "/archive") {
      const prefix = url.searchParams.get("prefix");
      if (!prefix || !/^(sightings|guesses|documents)\//.test(prefix)) {
        return Response.json({ error: "prefix must start with sightings/, guesses/ or documents/" }, { status: 400 });
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
      const instance = await env.MANUFACTURER_CRAWL.create({
        id: `maker-${manufacturerId}-${checkedAt}`,
        params: { manufacturerId, domains, checkedAt, ...(pages ? { pageLimit: Number(pages) } : {}) },
      });
      return Response.json({ id: instance.id });
    }
    if (request.method === "POST" && url.pathname === "/convert") {
      const manufacturerId = url.searchParams.get("id");
      const checkedAt = url.searchParams.get("date");
      if (!manufacturerId || !checkedAt) return Response.json({ error: "id and date required" }, { status: 400 });
      // Reading follows conversion on its own: each converted document enqueues its own reading.
      return Response.json(await convertRun(env, manufacturerId, checkedAt));
    }
    if (request.method === "POST" && url.pathname === "/approve") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
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

  /** Weekly: one instance per seller. Listings rot faster than register maps, and slower than a day. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const checkedAt = today();
    for (const seller of sellers) {
      if (hasFeed(seller)) {
        const params: SellerCrawlParams = { sellerId: seller.id, checkedAt };
        await env.SELLER_CRAWL.create({ id: instanceId(seller.id, checkedAt), params });
      } else {
        await env.PAGE_CRAWL.create({ id: `page-${instanceId(seller.id, checkedAt)}`, params: { sellerId: seller.id, checkedAt } });
      }
    }
  },
  /** Every unit of fan-out work. Acknowledged or retried per message, never per batch. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await consume(batch, env);
  },
} satisfies ExportedHandler<Env>;

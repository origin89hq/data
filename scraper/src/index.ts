import { sellers } from "./sellers.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";

export { SellerCrawl } from "./seller-crawl.ts";
export { ClassifySightings } from "./classify-sightings.ts";

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
    if (request.method === "POST" && url.pathname === "/run") {
      const sellerId = url.searchParams.get("seller");
      if (!sellerId || !sellers.some((s) => s.id === sellerId)) return Response.json({ error: "unknown seller" }, { status: 400 });
      const checkedAt = url.searchParams.get("date") ?? today();
      const params: SellerCrawlParams = { sellerId, checkedAt };
      const instance = await env.SELLER_CRAWL.create({ id: instanceId(sellerId, checkedAt), params });
      return Response.json({ id: instance.id });
    }
    if (request.method === "POST" && url.pathname === "/classify") {
      const sellerId = url.searchParams.get("seller");
      const checkedAt = url.searchParams.get("date");
      if (!sellerId || !checkedAt) return Response.json({ error: "seller and date required" }, { status: 400 });
      const instance = await env.CLASSIFY_SIGHTINGS.create({ id: `classify-${instanceId(sellerId, checkedAt)}`, params: { sellerId, checkedAt } });
      return Response.json({ id: instance.id });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const binding = id.startsWith("classify-") ? env.CLASSIFY_SIGHTINGS : env.SELLER_CRAWL;
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
      const params: SellerCrawlParams = { sellerId: seller.id, checkedAt };
      await env.SELLER_CRAWL.create({ id: instanceId(seller.id, checkedAt), params });
    }
  },
} satisfies ExportedHandler<Env>;

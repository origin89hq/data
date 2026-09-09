import { sellers } from "./sellers.ts";
import { hasFeed } from "./feeds.ts";
import { CrawlApproval } from "./documents.ts";
import { APPROVAL_EVENT } from "./manufacturer-crawl.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";

export { SellerCrawl } from "./seller-crawl.ts";
export { ClassifySightings } from "./classify-sightings.ts";
export { PageCrawl } from "./page-crawl.ts";
export { ManufacturerCrawl } from "./manufacturer-crawl.ts";
export { DocumentConvert } from "./document-convert.ts";
export { ExtractSpecs } from "./extract-specs.ts";

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
    if (request.method === "POST" && url.pathname === "/classify") {
      const sellerId = url.searchParams.get("seller");
      const checkedAt = url.searchParams.get("date");
      if (!sellerId || !checkedAt) return Response.json({ error: "seller and date required" }, { status: 400 });
      const instance = await env.CLASSIFY_SIGHTINGS.create({ id: `classify-${instanceId(sellerId, checkedAt)}`, params: { sellerId, checkedAt } });
      return Response.json({ id: instance.id });
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
      const instance = await env.DOCUMENT_CONVERT.create({ id: `convert-${manufacturerId}-${checkedAt}`, params: { manufacturerId, checkedAt } });
      return Response.json({ id: instance.id });
    }
    if (request.method === "POST" && url.pathname === "/extract") {
      const manufacturerId = url.searchParams.get("id");
      const checkedAt = url.searchParams.get("date");
      if (!manufacturerId || !checkedAt) return Response.json({ error: "id and date required" }, { status: 400 });
      const instance = await env.EXTRACT_SPECS.create({ id: `extract-${manufacturerId}-${checkedAt}`, params: { manufacturerId, checkedAt } });
      return Response.json({ id: instance.id });
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
      const binding = id.startsWith("classify-") ? env.CLASSIFY_SIGHTINGS : id.startsWith("page-") ? env.PAGE_CRAWL : id.startsWith("extract-") ? env.EXTRACT_SPECS : id.startsWith("convert-") ? env.DOCUMENT_CONVERT : id.startsWith("maker-") ? env.MANUFACTURER_CRAWL : env.SELLER_CRAWL;
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
} satisfies ExportedHandler<Env>;

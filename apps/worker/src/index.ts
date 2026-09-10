import { consume } from "./consumer.ts";
import { hasFeed } from "./feeds.ts";
import { manufacturers } from "./manufacturers.ts";
import { app, today } from "./routes.ts";
import { newRun } from "./runs.ts";
import type { SellerCrawlParams } from "./seller-crawl.ts";
import { sellers } from "./sellers.ts";
import { supervise } from "./supervise.ts";

export { ManufacturerCrawl } from "./manufacturer-crawl.ts";
export { PageCrawl } from "./page-crawl.ts";
export { SellerCrawl } from "./seller-crawl.ts";

export default {
  /** Every request. The routes and who may call them live in `routes.ts`. */
  fetch: app.fetch,

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
        await env.MANUFACTURER_CRAWL.create({
          id,
          params: {
            instanceId: id,
            run: run.id,
            manufacturerId: maker.id,
            domains: maker.domains,
            checkedAt: run.date,
            pageLimit: 150,
          },
        });
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
        await env.PAGE_CRAWL.create({
          id: `page-${run.id}`,
          params: { sellerId: seller.id, run: run.id, checkedAt: run.date },
        });
      }
    }
  },
  /** Every unit of fan-out work. Acknowledged or retried per message, never per batch. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await consume(batch, env);
  },
} satisfies ExportedHandler<Env>;

import { consume } from "./consumer.ts";
import { hasFeed } from "./feeds.ts";
import { manufacturers } from "./manufacturers.ts";
import { app, today } from "./routes.ts";
import { sellers } from "./sellers.ts";
import { startIfFree, startMaker, startSeller } from "./start-run.ts";
import { superviseIfFree } from "./supervise.ts";

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
        await startIfFree(() => startMaker(env, maker.id, maker.domains, 150));
      }
    }
    // Every day: move anything whose precondition is met. The weekly crawl and the monthly
    // discovery below produce work; this is what carries it through the stages after them.
    await superviseIfFree(env, checkedAt);
    if (new Date(controller.scheduledTime).getUTCHours() === 8) return;
    for (const seller of sellers) {
      await startIfFree(() => startSeller(env, seller.id, hasFeed(seller) ? "feed" : "page"));
    }
  },
  /** Every unit of fan-out work. Acknowledged or retried per message, never per batch. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await consume(batch, env);
  },
} satisfies ExportedHandler<Env>;

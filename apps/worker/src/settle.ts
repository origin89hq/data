import { Work } from "./work.ts";

/**
 * The queue handler's loop, kept apart from the handlers so it can be tested without PDFium.
 * Messages are taken one at a time, not with Promise.all: a batch of ten documents converted at
 * once put ten PDFs into one isolate's memory and lost half of them. The parallelism worth having
 * is across consumers, which the queue's own concurrency provides; inside one invocation it only
 * shares a single memory and CPU budget between ten heavy jobs.
 *
 * Each message is acknowledged or retried on its own, so one bad document cannot take the rest
 * of its batch down with it.
 */
export async function settle(
  batch: MessageBatch<unknown>,
  handle: (work: Work, attempt: number) => Promise<void>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handle(Work.parse(message.body), message.attempts);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "work failed",
          attempt: message.attempts,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      // A message that does not parse is retried like any other, and dead-letters once its
      // attempts are spent. It used to be acknowledged, which drops a message rather than
      // dead-lettering it, and the loop then returned: the queue takes whatever a handler that
      // returns has neither acknowledged nor retried as done, so the rest of the batch went
      // unread. Retried, a message this version cannot parse may reach one that can, mid-deploy.
      message.retry();
    }
  }
}

/**
 * How many listings, pointers or runs are read out of R2 at once. A Worker keeps six calls waiting
 * for an answer and queues the rest, so six keeps every connection busy. More would only wait in
 * line, each holding whatever it had already read.
 */
export const R2_AT_ONCE = 6;

/**
 * `task` over every item, at most `limit` at a time, answered in the items' order.
 *
 * The first failure is the answer. No item starts after it; the ones already running finish
 * unread. A limit below one would start nothing and answer an empty list, which reads exactly
 * like there being nothing to do, so it is refused.
 */
export async function atOnce<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(`limit must be a whole number from 1, not ${limit}`);
  const out: R[] = [];
  // One iterator shared by every worker, so each item is taken exactly once.
  const pending = items.entries();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const [i, item] of pending) {
      if (failed) return;
      try {
        out[i] = await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

import { z } from "zod";
import { Sighting } from "../../schema/sighting.ts";

/**
 * Work that fans out. These are independent units with no order between them: one batch of
 * listings to classify, one document to convert, one document to read. They were workflow steps
 * once, which meant five hundred model calls running strictly one after another inside a single
 * instance — durable, and half an hour of wall clock for work that shares nothing.
 *
 * What stays a workflow is the maker pipeline, because it has a sequence and a wait for a person.
 */
export const Work = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("classify"),
      seller: z.string().min(1),
      date: z.string().min(1),
      /** Which part of the run this is, so its result has a key the reader can predict. */
      part: z.number().int().positive(),
      sightings: z.array(Sighting).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("convert"),
      manufacturer: z.string().min(1),
      date: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      url: z.string().url(),
      contentType: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extract"),
      manufacturer: z.string().min(1),
      date: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      url: z.string().url(),
      /** The markdown to read, which the conversion wrote. */
      key: z.string().min(1),
      /** Windows this message may read, so one long manual cannot spend a run's whole budget. */
      maxWindows: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type Work = z.infer<typeof Work>;

/**
 * Where each unit writes its result. Keys are derived, never generated, so a reader knows what to
 * look for and a missing part is visible as a gap rather than as a shorter answer.
 */
export const partKey = {
  classify: (classifier: string, seller: string, date: string, part: number) =>
    `guesses/${seller}/${date}/${classifier}/page-${String(part).padStart(4, "0")}.jsonl`,
  /**
   * A classification keyed by what was classified, not by when. The same listing crawled every
   * week is the same question, and asking a model again each time is the whole cost of a re-run
   * for no new answer.
   */
  classified: (classifier: string, input: string) => `guesses/by-input/${classifier}/${input}.json`,
  markdown: (sha256: string, converter: string) => `archive/${sha256}.${converter}.md`,
  converted: (manufacturer: string, date: string, sha256: string) => `documents/${manufacturer}/${date}/converted/${sha256}.json`,
  reading: (manufacturer: string, date: string, sha256: string, extractor: string) =>
    `documents/${manufacturer}/${date}/readings/${extractor}/${sha256}.json`,
};

/**
 * What a classification actually depends on: the fields the prompt is given, and nothing else.
 * The seller, the price and the date are deliberately absent — the same product at two shops is
 * one question, and a price change is not a reason to ask it again.
 */
export async function inputKey(sighting: { title: string; brand?: string; sku?: string; model?: string; category?: string; variant?: string }): Promise<string> {
  const material = [sighting.title, sighting.brand ?? "", sighting.sku ?? "", sighting.model ?? "", sighting.category ?? "", sighting.variant ?? ""].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

/** Split a list into fixed-size batches, which is how a run becomes messages. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A sendBatch takes at most this many messages, and at most SEND_BYTES of them together. */
export const SEND_BATCH = 100;

/**
 * The size ceiling for one sendBatch. The documented limit is 256 KB in total; this leaves room
 * for the envelope each message travels in. Counting messages alone is not enough — a hundred
 * batches of listings are comfortably over the ceiling, and the queue answers with an internal
 * error that says nothing about size.
 */
export const SEND_BYTES = 220_000;

/** Split by both limits at once, since either one alone lets a batch through that the queue refuses. */
export function sendGroups(messages: Work[], maxCount = SEND_BATCH, maxBytes = SEND_BYTES): Work[][] {
  const groups: Work[][] = [];
  let group: Work[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = JSON.stringify(message).length;
    if (group.length > 0 && (group.length >= maxCount || bytes + size > maxBytes)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(message);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export async function sendAll(queue: Queue<Work>, messages: Work[]): Promise<number> {
  for (const group of sendGroups(messages)) await queue.sendBatch(group.map((body) => ({ body })));
  return messages.length;
}

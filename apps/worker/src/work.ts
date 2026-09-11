import { Sighting } from "@origin89/equipment-schema/sighting";
import { z } from "zod";

/**
 * The most windows one extract message may ask for. Each window read is a model call and an R2
 * write, and a delivery after a failure reads back every window kept; at four hundred that stays
 * well under the thousand subrequests one Worker invocation may make.
 */
export const MOST_WINDOWS = 400;

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
      /** The run this work belongs to. Results land under it, so two runs cannot mix. */
      run: z.string().min(1),
      /** Which part of the run this is, so its result has a key the reader can predict. */
      part: z.number().int().positive(),
      sightings: z.array(Sighting).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("convert"),
      /** The run this work belongs to. Results land under it, so two runs cannot mix. */
      run: z.string().min(1),
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
      /** The run this work belongs to. Results land under it, so two runs cannot mix. */
      run: z.string().min(1),
      manufacturer: z.string().min(1),
      date: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      url: z.string().url(),
      /** The markdown to read, which the conversion wrote. */
      key: z.string().min(1),
      /** Windows this message may read, so one long manual cannot spend a run's whole budget. */
      maxWindows: z.number().int().positive().max(MOST_WINDOWS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spec-table"),
      /** The run this work belongs to. Results land under it, so two runs cannot mix. */
      run: z.string().min(1),
      manufacturer: z.string().min(1),
      date: z.string().min(1),
      /** A page the maker publishes its own specification table on. */
      url: z.string().url(),
    })
    .strict(),
  z
    .object({
      /** Whether a converted document needs its pages looked at, and if so, one message per page. */
      kind: z.literal("vision"),
      /** The run this work belongs to. Results land under it, so two runs cannot mix. */
      run: z.string().min(1),
      manufacturer: z.string().min(1),
      date: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      url: z.string().url(),
    })
    .strict(),
  z
    .object({
      /** One page of a document with no text layer, drawn and read. */
      kind: z.literal("vision-page"),
      /** The run this work belongs to. Results land under it, so two runs cannot mix. */
      run: z.string().min(1),
      manufacturer: z.string().min(1),
      date: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      url: z.string().url(),
      /** Counted from one, as the converter counts them. */
      page: z.number().int().positive(),
      /** How many pages the reading waits for, so whichever page lands last can put them together. */
      pages: z.number().int().positive(),
      /** Times the page was put back to wait its turn with the model, so the waiting has an end. */
      waits: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine((m) => m.page <= m.pages, {
      message: "a page past the last one the reading waits for",
    }),
]);
export type Work = z.infer<typeof Work>;

/**
 * The last delivery a message gets. `max_retries` in wrangler.jsonc is 3 and the first delivery is
 * not a retry. A test reads the configuration, so the two cannot drift apart.
 */
export const LAST_ATTEMPT = 4;

/** A reader's id as it appears in a key: `ai:@cf/x@p2` is `ai_cf_x_p2`. */
export { readerKey } from "@origin89/equipment-schema/provenance";

/**
 * Where each unit writes its result. Keys are derived, never generated, so a reader knows what to
 * look for and a missing part is visible as a gap rather than as a shorter answer.
 */
export const partKey = {
  classify: (classifier: string, seller: string, run: string, part: number) =>
    `guesses/${seller}/runs/${run}/${classifier}/page-${String(part).padStart(4, "0")}.jsonl`,
  /**
   * A classification keyed by what was classified, not by when. The same listing crawled every
   * week is the same question, and asking a model again each time is the whole cost of a re-run
   * for no new answer.
   */
  classified: (classifier: string, input: string) => `guesses/by-input/${classifier}/${input}.json`,
  markdown: (sha256: string, converter: string) => `archive/${sha256}.${converter}.md`,
  converted: (manufacturer: string, run: string, sha256: string) =>
    `documents/${manufacturer}/runs/${run}/converted/${sha256}.json`,
  /**
   * A reading is a function of the document's bytes and the reader, and of nothing else — so it
   * lives beside the document, not inside a run. Keying it per run meant a second run re-read
   * nine hundred documents it had already paid to read, for the same answer.
   */
  reading: (sha256: string, extractor: string) => `archive/${sha256}.${extractor}.reading.json`,
  /**
   * One page of a reading that is read a page at a time. Beside the document for the same reason
   * the reading is: a page read once is never read again, whichever run asks.
   */
  page: (sha256: string, extractor: string, page: number) =>
    `archive/${sha256}.${extractor}.page-${String(page).padStart(4, "0")}.json`,
  /** Every page of that reading, and nothing else: the prefix ends before the page number. */
  pages: (sha256: string, extractor: string) => `archive/${sha256}.${extractor}.page-`,
  /** One window of a reading that is read a window at a time. Beside the document, like its pages. */
  window: (sha256: string, extractor: string, window: number) =>
    `archive/${sha256}.${extractor}.window-${String(window).padStart(4, "0")}.json`,
  /** Every window of that reading, and nothing else. */
  windows: (sha256: string, extractor: string) => `archive/${sha256}.${extractor}.window-`,
};

/**
 * What a classification actually depends on: the fields the prompt is given, and nothing else.
 * The seller, the price and the date are deliberately absent — the same product at two shops is
 * one question, and a price change is not a reason to ask it again.
 *
 * The rated figures a listing carries are given to the model too, and a changed line is new
 * evidence, so they are part of the question. They are added only when present, so a listing
 * without them keeps the key, and the stored answer, it always had.
 */
export async function inputKey(sighting: {
  title: string;
  brand?: string;
  sku?: string;
  model?: string;
  category?: string;
  variant?: string;
  figures?: string;
}): Promise<string> {
  const material = [
    sighting.title,
    sighting.brand ?? "",
    sighting.sku ?? "",
    sighting.model ?? "",
    sighting.category ?? "",
    sighting.variant ?? "",
    ...(sighting.figures ? [sighting.figures] : []),
  ].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
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
export function sendGroups(
  messages: Work[],
  maxCount = SEND_BATCH,
  maxBytes = SEND_BYTES,
): Work[][] {
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

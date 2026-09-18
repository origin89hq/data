/** Pinned so a guess can say exactly what produced it. Bump the prompt version when the prompt changes. */
export const CLASSIFIER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const PROMPT_VERSION = "4";
export const CLASSIFIER_ID = `ai:${CLASSIFIER_MODEL}@p${PROMPT_VERSION}`;

/** The classifier's id as a key segment: an R2 key cannot carry the slashes and @ of a model name. */
export function classifierKey(id = CLASSIFIER_ID): string {
  return id.replace(/[^\w.-]+/g, "_");
}

/**
 * The text reader. Kimi K2.7 replaced Llama 3.3 70B after a blind comparison on sixty windows of
 * twenty documents whose figures had been checked against their text (the figures pull #196): with
 * the same prompt it gave about half again as many right figures and about forty percent fewer wrong
 * ones, and read almost no value from another column or model. A new model is a new reader id, so
 * every document counts as unread by it until `just convert` reads it again; the earlier readings
 * stay in the archive and are no longer pulled.
 */
export const EXTRACT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
/**
 * 3: the reader labels each product (a product, a family, a kit, another company's) and each figure
 * (a rating, a setting, an instruction, a test, an example), and only ratings of products are kept.
 * 4: a PDF is converted from where its characters sit, so a table keeps its columns and a value
 * stays under the model it belongs to, and each window is read with the section the document prints
 * it in. A reading is keyed by the document, the maker and the reader, but not by the converter, so
 * this version is what makes documents be read from the new text rather than from the old.
 */
export const EXTRACT_PROMPT_VERSION = "4";
export const EXTRACTOR_ID = `ai:${EXTRACT_MODEL}@p${EXTRACT_PROMPT_VERSION}`;

/**
 * Text readers before this one. A document one of them read has been read before, which the
 * spec-pages pass needs to know: it runs for a maker none of whose documents is read yet, and a new
 * reader would otherwise fetch every adopted page again on each pass until its own readings exist.
 */
export const EARLIER_EXTRACTOR_IDS: readonly string[] = [
  "ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast@p2",
  "ai:@cf/moonshotai/kimi-k2.7-code@p2",
  "ai:@cf/moonshotai/kimi-k2.7-code@p3",
];

/**
 * What sorts a converted document by kind before it is read: certificates, compatibility notes,
 * safety data sheets and the like are not the maker's ratings, and are not read at all.
 */
export const GATE_ID = `ai:${EXTRACT_MODEL}@gate-p1`;

export const VISION_MODEL = "@cf/moonshotai/kimi-k2.7-code";
/**
 * 2: the first version's readings kept pages refused by the model's rate limit as read (#29). A new
 * version is a new key, so every scan is read again rather than trusted.
 * 3: figures are read from the whole transcript, not page by page, so a name printed on one page
 * reaches the figures on another, and form numbers, range headings and test results are not taken
 * for products (#28). The transcription has a version of its own and is not redone for this.
 */
export const VISION_PROMPT_VERSION = "3";
export const VISION_EXTRACTOR_ID = `ai:${VISION_MODEL}@vision-p${VISION_PROMPT_VERSION}`;

/**
 * Whether the figures pull takes the page reader's readings. Not for now: its first readings filed
 * figures under the wrong model names (#28) and kept rate-limited pages as read (#29).
 *
 * Two places have to agree on it, so both read this: the readers the pull asks for, and the check
 * that a run has been read by one of them. A run only a left-out reader has read would pull no
 * readings, and every unreviewed figure the maker has would then be removed as stale.
 */
export const PULL_PAGE_READER = false;

/** A reader's id as it appears in an archive key. */
export const readerKey = (extractor: string): string => extractor.replace(/[^\w.-]+/g, "_");

/**
 * How many readings one request may ask the Worker for.
 *
 * A Worker gets a bounded number of subrequests and every reading is one of them, so a batch has
 * a ceiling. The number lives beside the reader keys because both ends need the same one: the
 * Worker refuses a batch over it, and the caller sizes its batches by it. Trimming instead would
 * have answered 200 with fewer readings, which reads exactly like documents nobody had read.
 */
export const READS_PER_REQUEST = 2000;

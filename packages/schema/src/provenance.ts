/** Pinned so a guess can say exactly what produced it. Bump the prompt version when the prompt changes. */
export const CLASSIFIER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const PROMPT_VERSION = "4";
export const CLASSIFIER_ID = `ai:${CLASSIFIER_MODEL}@p${PROMPT_VERSION}`;

/** The classifier's id as a key segment: an R2 key cannot carry the slashes and @ of a model name. */
export function classifierKey(id = CLASSIFIER_ID): string {
  return id.replace(/[^\w.-]+/g, "_");
}

export const EXTRACT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const EXTRACT_PROMPT_VERSION = "2";
export const EXTRACTOR_ID = `ai:${EXTRACT_MODEL}@p${EXTRACT_PROMPT_VERSION}`;

export const VISION_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const VISION_PROMPT_VERSION = "1";
export const VISION_EXTRACTOR_ID = `ai:${VISION_MODEL}@vision-p${VISION_PROMPT_VERSION}`;

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

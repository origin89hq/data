import { classifierKey } from "./classify.ts";
import { EXTRACTOR_ID } from "./reading.ts";
import { TABLE_READER } from "./spec-table.ts";

/**
 * What the spider knows and what it is waiting on, derived from the archive rather than kept
 * beside it. Every stage already writes a manifest when it finishes, so the archive is the state:
 * a second copy would be a second thing to keep true, and the first to go stale.
 *
 * The failure this answers is the quiet one. A weekly cron can lose a dozen crawls and nothing
 * says so; a run can stop halfway and look exactly like a shop that shrank.
 */

/** Where one seller's week got to. */
export interface SellerState {
  seller: string;
  date?: string;
  sightings?: number;
  classified?: { parts: number; written: number };
}

/** Where one maker got to, and what it is waiting for. */
export interface MakerState {
  maker: string;
  date?: string;
  /** Documents discovery offered, before anybody approved any. */
  offered?: number;
  /** Pages of its own that carry a specification table. */
  specPages?: number;
  approvedBy?: string;
  fetched?: number;
  converted?: number;
  read?: number;
  /** What has to happen next, in the words somebody would use out loud. */
  waitingOn: string;
}

const listAll = async (bucket: R2Bucket, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
};

const json = async <T>(bucket: R2Bucket, key: string): Promise<T | undefined> => {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : undefined;
};

/** The most recent date a prefix holds, since every stage is keyed by the day it ran. */
function latest(keys: string[], depth: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) {
    const parts = key.split("/");
    const entity = parts[1];
    const date = parts[depth];
    if (!entity || !date) continue;
    const seen = out.get(entity);
    if (!seen || date > seen) out.set(entity, date);
  }
  return out;
}

export async function sellerStates(bucket: R2Bucket): Promise<SellerState[]> {
  const keys = await listAll(bucket, "sightings/");
  const out: SellerState[] = [];
  for (const [seller, date] of [...latest(keys, 2)].sort()) {
    const manifest = await json<{ sightings: number }>(bucket, `sightings/${seller}/${date}/manifest.json`);
    const guessPrefix = `guesses/${seller}/${date}/${classifierKey()}`;
    const guesses = await json<{ parts: number }>(bucket, `${guessPrefix}/manifest.json`);
    const written = guesses ? (await listAll(bucket, `${guessPrefix}/page-`)).length : 0;
    out.push({
      seller,
      date,
      ...(manifest ? { sightings: manifest.sightings } : {}),
      ...(guesses ? { classified: { parts: guesses.parts, written } } : {}),
    });
  }
  return out;
}

export async function makerStates(bucket: R2Bucket): Promise<MakerState[]> {
  const keys = await listAll(bucket, "documents/");
  const out: MakerState[] = [];
  for (const [maker, date] of [...latest(keys, 2)].sort()) {
    const base = `documents/${maker}/${date}`;
    const plan = await json<{ documents: unknown[] }>(bucket, `${base}/plan.json`);
    const specPages = await json<{ candidates: number }>(bucket, `${base}/spec-pages.json`);
    const manifest = await json<{ approvedBy: string; fetched: number }>(bucket, `${base}/manifest.json`);
    const converting = await json<{ documents: unknown[] }>(bucket, `${base}/converting.json`);
    const converted = (await listAll(bucket, `${base}/converted/`)).length;
    const readModel = (await listAll(bucket, `${base}/readings/${EXTRACTOR_ID.replace(/[^\w.-]+/g, "_")}/`)).length;
    const readTable = (await listAll(bucket, `${base}/readings/${TABLE_READER.replace(/[^\w.-]+/g, "_")}/`)).length;
    const read = readModel + readTable;

    const offered = plan?.documents?.length ?? 0;
    let waitingOn = "nothing";
    if (!plan) waitingOn = "discovery";
    else if (offered === 0 && !specPages) waitingOn = "nothing to fetch; this maker publishes no documents we can reach";
    else if (!manifest && offered > 0) waitingOn = "somebody to approve the download";
    else if (manifest && !converting) waitingOn = "conversion to be started";
    else if (converting && converted < converting.documents.length) waitingOn = `conversion, ${converting.documents.length - converted} of ${converting.documents.length} left`;
    else if (converting && read < converted) waitingOn = `reading, ${converted - read} of ${converted} left`;
    else if (read > 0) waitingOn = "its figures to be pulled into records";

    out.push({
      maker,
      date,
      offered,
      ...(specPages ? { specPages: specPages.candidates } : {}),
      ...(manifest ? { approvedBy: manifest.approvedBy, fetched: manifest.fetched } : {}),
      ...(converting ? { converted } : {}),
      ...(read ? { read } : {}),
      waitingOn,
    });
  }
  return out;
}

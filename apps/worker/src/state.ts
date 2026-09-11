import { PULL_PAGE_READER } from "@origin89/equipment-schema/provenance";
import { classifierKey } from "./classify.ts";
import { EXTRACTOR_ID, VISION_EXTRACTOR_ID } from "./reading.ts";
import { currentRuns, runPrefix } from "./runs.ts";
import { readerKey } from "./work.ts";

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
  /**
   * Documents sent to conversion: those fetched, less duplicates and translations. Conversion is
   * finished when `converted` reaches this, which `fetched` cannot say.
   */
  sent?: number;
  converted?: number;
  read?: number;
  /** How many converted documents there were when the run was last offered to the page reader. */
  seeing?: number;
  /** Documents with no text layer that the page reader has read. */
  seen?: number;
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

/** The sha256 of every document the text reader has read, and of every one the page reader has. */
const readingsPresent = async (
  bucket: R2Bucket,
): Promise<{ text: Set<string>; pages: Set<string> }> => {
  const text = `.${readerKey(EXTRACTOR_ID)}.reading.json`;
  const pages = `.${readerKey(VISION_EXTRACTOR_ID)}.reading.json`;
  const present = { text: new Set<string>(), pages: new Set<string>() };
  // One listing for both: the archive holds every document there is, and listing it is the cost.
  for (const key of await listAll(bucket, "archive/")) {
    if (key.endsWith(text)) present.text.add(key.slice("archive/".length, -text.length));
    else if (key.endsWith(pages)) present.pages.add(key.slice("archive/".length, -pages.length));
  }
  return present;
};

const json = async <T>(bucket: R2Bucket, key: string): Promise<T | undefined> => {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : undefined;
};

export async function sellerStates(bucket: R2Bucket): Promise<SellerState[]> {
  const out: SellerState[] = [];
  // Whatever each seller's pointer says is current. Guessing from the latest date was the same
  // mistake in a reader that the crawls have already stopped making in their writes.
  for (const { entity: seller, pointer } of await currentRuns(bucket, "sightings")) {
    const date = pointer.date;
    const manifest = await json<{ sightings: number }>(
      bucket,
      `${runPrefix.sightings(seller, pointer.run)}/manifest.json`,
    );
    const guessPrefix = runPrefix.guesses(seller, pointer.run, classifierKey());
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
  const out: MakerState[] = [];
  // Every reading there is, listed once. This used to be a HEAD per approved document per maker,
  // which is thousands of requests for one status call and a miss logged for each of the documents
  // not read yet — the normal answer, reported by R2 as a failed HeadObject.
  const readings = await readingsPresent(bucket);
  for (const { entity: maker, pointer } of await currentRuns(bucket, "documents")) {
    const date = pointer.date;
    const base = runPrefix.documents(maker, pointer.run);
    const plan = await json<{ documents: unknown[] }>(bucket, `${base}/plan.json`);
    const specPages = await json<{ candidates: number }>(bucket, `${base}/spec-pages.json`);
    const manifest = await json<{ approvedBy: string; fetched: number }>(
      bucket,
      `${base}/manifest.json`,
    );
    const converting = await json<{ documents: { sha256: string }[] }>(
      bucket,
      `${base}/converting.json`,
    );
    const converted = (await listAll(bucket, `${base}/converted/`)).length;
    // An offer to an earlier page reader is not an offer to this one. A new version is how its
    // readings are made again, and nothing reads a document it was never offered.
    const offer = await json<{ converted: number; extractedBy?: string }>(
      bucket,
      `${base}/seeing.json`,
    );
    const seeing = offer?.extractedBy === VISION_EXTRACTOR_ID ? offer : undefined;
    // Readings live beside their documents, so this run's progress is how many of the documents
    // it approved have one.
    let read = 0;
    let seen = 0;
    for (const doc of converting?.documents ?? []) {
      const sha = (doc as { sha256?: string }).sha256;
      if (sha && readings.text.has(sha)) read += 1;
      if (sha && readings.pages.has(sha)) seen += 1;
    }

    const offered = plan?.documents?.length ?? 0;
    let waitingOn = "nothing";
    if (!plan) waitingOn = "discovery";
    else if (offered === 0 && !specPages)
      waitingOn = "nothing to fetch; this maker publishes no documents we can reach";
    else if (!manifest && offered > 0) waitingOn = "somebody to approve the download";
    else if (manifest && !converting) waitingOn = "conversion to be started";
    else if (converting && converted < converting.documents.length)
      waitingOn = `conversion, ${converting.documents.length - converted} of ${converting.documents.length} left`;
    else if (converting && read < converted)
      waitingOn = `reading, ${converted - read} of ${converted} left`;
    else if (read > 0) waitingOn = "its figures to be pulled into records";

    out.push({
      maker,
      date,
      offered,
      ...(specPages ? { specPages: specPages.candidates } : {}),
      ...(manifest ? { approvedBy: manifest.approvedBy, fetched: manifest.fetched } : {}),
      ...(converting ? { sent: converting.documents.length, converted } : {}),
      ...(read ? { read } : {}),
      ...(seeing ? { seeing: seeing.converted } : {}),
      ...(seen ? { seen } : {}),
      waitingOn,
    });
  }
  return out;
}

/**
 * Whether a maker's figures can be pulled into records without taking any away by mistake: its
 * current run has finished converting, and a reader the pull takes has read it. The page reader's
 * readings count only while `PULL_PAGE_READER` lets the pull take them.
 *
 * The pointer moves when discovery starts, so on the first of every month each maker's current run
 * is one with nothing converted until somebody approves it. Pulling that run would read as every
 * figure the maker has going stale, and delete them. A run still converting is partway there.
 * Both are told by counts rather than by `waitingOn`, which is written for a person to read.
 */
export function readyToPull(maker: MakerState): boolean {
  if (!maker.date || maker.sent === undefined || maker.converted === undefined) return false;
  if (maker.converted < maker.sent) return false;
  return (maker.read ?? 0) + (PULL_PAGE_READER ? (maker.seen ?? 0) : 0) > 0;
}

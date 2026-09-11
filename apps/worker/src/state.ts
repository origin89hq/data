import { PULL_PAGE_READER } from "@origin89/equipment-schema/provenance";
import { classifierKey } from "./classify.ts";
import type { DiscoverySeen } from "./discover.ts";
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
  /** The current run, so a reader can find the one before it. */
  run?: string;
  /** The workflow instance behind the current run, so its status can be asked when it wrote nothing. */
  instance?: string;
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
    const manifestOfGuesses = await json<{ parts: number; alreadyAnswered?: number }>(
      bucket,
      `${guessPrefix}/manifest.json`,
    );
    // A manifest from before every listing was queued left out the ones answered earlier, and the
    // gate reads a run's guesses from its parts (#16). Such a run is classified again: reusing the
    // answers costs reads, not model calls.
    const guesses = manifestOfGuesses?.alreadyAnswered ? undefined : manifestOfGuesses;
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

/**
 * Why a plan offers nothing, in the words somebody would use out loud. Forty-three makers had one
 * sentence between them, and it was wrong for most: the site had refused, moved, or kept its
 * documents on a host the record does not claim (#48). A plan written before discovery recorded
 * what it saw keeps the old sentence.
 */
export function emptyPlanReason(seen: DiscoverySeen | undefined): string {
  if (!seen) return "nothing to fetch; this maker publishes no documents we can reach";
  // A site has moved when every host's sitemap request landed elsewhere, or when nothing at all
  // could be read and something did; one page that went elsewhere is a footnote, not the reason.
  const moved =
    seen.redirectedTo.length > 0 &&
    (seen.hosts.every((h) => h.redirectedTo.length > 0) || seen.pages.read === 0);
  if (moved)
    return `nothing to fetch; the site redirects to ${seen.redirectedTo.join(", ")}, which the record does not claim`;
  const strayed =
    seen.redirectedTo.length > 0
      ? `, and some requests landed on ${seen.redirectedTo.join(", ")}`
      : "";
  const failures = Object.entries(seen.pages.failed);
  const failed = failures.reduce((n, [, count]) => n + count, 0);
  const sum = (
    field: "requests" | "refused" | "silent" | "childrenFailed" | "childrenSkipped",
  ): number => seen.hosts.reduce((n, h) => n + h[field], 0);
  // Every request made: each sitemap and child sitemap asked for, and each page.
  const asked = sum("requests") + seen.pages.read + failed;
  const refused = sum("refused") + (seen.pages.failed["403"] ?? 0);
  if (seen.pages.read === 0 && refused > 0)
    return `nothing to fetch; the site refused the crawler (403 on ${refused} of ${asked} requests)`;
  const silent = sum("silent") + (seen.pages.failed["0"] ?? 0);
  if (seen.pages.read === 0 && silent === asked) return "nothing to fetch; the site did not answer";
  const elsewhere = Object.entries(seen.foreignDocumentHosts).sort((a, b) => b[1] - a[1]);
  if (elsewhere.length > 0) {
    const documents = elsewhere.reduce((n, [, count]) => n + count, 0);
    const hosts = elsewhere.slice(0, 3).map(([host]) => host);
    const more = elsewhere.length - hosts.length;
    const others = more > 0 ? ` and ${more} more host${more === 1 ? "" : "s"}` : "";
    return `nothing to fetch; ${documents} documents are on ${hosts.join(", ")}${others}, which the record does not claim`;
  }
  if (seen.pages.read === 0)
    return `nothing to fetch; no page could be read (${failures.map(([status, n]) => `${n} answered ${status}`).join(", ")})`;
  // A sitemap index whose children would not load is a site only partly seen, not an empty one.
  const unread = sum("childrenFailed");
  const unopened = sum("childrenSkipped");
  const partly = [
    ...(unread > 0 ? [`${unread} of its sitemaps could not be read`] : []),
    ...(unopened > 0 ? [`${unopened} of its sitemaps were left unopened`] : []),
  ];
  const rest = partly.length ? `, and ${partly.join(" and ")}` : "";
  const listed = seen.pages.listed ?? 0;
  const sampled = listed > seen.pages.read + failed ? ` of ${listed} the site lists` : "";
  return `nothing to fetch; read ${seen.pages.read} pages${sampled}, none links a document${rest}${strayed}`;
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
    const plan = await json<{ documents: unknown[]; discovery?: DiscoverySeen }>(
      bucket,
      `${base}/plan.json`,
    );
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
    else if (offered === 0 && !specPages) waitingOn = emptyPlanReason(plan.discovery);
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
      run: pointer.run,
      ...(pointer.instance ? { instance: pointer.instance } : {}),
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
 * The run before this one and how many documents its plan offered, for a pass that has to say
 * whether an empty discovery replaced a full one.
 *
 * The previous run is the one whose plan was written last before this run's, by the archive's
 * own clock. A run's name carries its day and then a random suffix, so two runs on one day do not
 * sort by age, and a run that died before writing a plan is no run to compare with: it is passed
 * over for the last one that finished discovery.
 */
/**
 * Days of runs looked at when finding the previous plan, one HEAD per run on those days. A pass
 * asks this for every maker whose plan is empty, forty-odd today, on top of the reads
 * `makerStates` already makes, under one invocation's thousand-subrequest ceiling. Three days
 * covers a re-run and the discovery before it; a run's predecessor is never older than that in
 * practice, and a maker with more history than that is bounded rather than fully searched.
 */
export const PREVIOUS_RUNS_CONSIDERED = 3;

export async function previousPlan(
  bucket: R2Bucket,
  maker: string,
  run: string,
): Promise<{ run: string; documents: number } | undefined> {
  const prefix = runPrefix.documents(maker, "");
  const runs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    for (const folded of page.delimitedPrefixes) runs.push(folded.slice(prefix.length, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const planKey = (r: string) => `${runPrefix.documents(maker, r)}/plan.json`;
  // One HEAD per run considered, and a pass asks for every empty maker: the newest runs by name
  // are enough, since a run's name starts with its day and the previous plan is a recent one.
  // Bounded by day rather than by name: a run's name starts with its day and ends in a random
  // suffix, so the newest names would not be the newest runs when a day holds several.
  const days = [...new Set(runs.map((r) => r.slice(0, 10)))]
    .sort()
    .reverse()
    .slice(0, PREVIOUS_RUNS_CONSIDERED);
  const recent = runs.filter((r) => r !== run && days.includes(r.slice(0, 10)));
  const written = async (r: string): Promise<number | undefined> =>
    (await bucket.head(planKey(r)))?.uploaded.getTime();
  // A current run still discovering has no plan yet, and then every earlier plan is before it.
  const cutoff = (await written(run)) ?? Number.POSITIVE_INFINITY;
  let previous: { run: string; at: number } | undefined;
  for (const other of recent) {
    const at = await written(other);
    if (at === undefined || at >= cutoff) continue;
    if (!previous || at > previous.at) previous = { run: other, at };
  }
  if (!previous) return undefined;
  const plan = await json<{ documents?: unknown[] }>(bucket, planKey(previous.run));
  return { run: previous.run, documents: plan?.documents?.length ?? 0 };
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

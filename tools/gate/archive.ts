import { execFileSync } from "node:child_process";
import { Sighting } from "../../schema/sighting.ts";
import { Guess } from "../../schema/guess.ts";
import { classifierKey } from "../../scraper/src/classify.ts";

const BUCKET = "offgrid-equipment-archive";
const SCRAPER = new URL("../../scraper/", import.meta.url).pathname;

/**
 * How much of one object to accept. A page of sightings from a large shop runs past a megabyte,
 * and the default buffer is exactly that: the first run of this reader reported a page as missing
 * when it was there and simply too big, which is the kind of failure that quietly shortens a
 * dataset instead of stopping it.
 */
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

/**
 * Read one object out of the crawl archive through wrangler, which owns the credentials. An
 * object that is not there returns nothing; anything else throws, because a read that failed
 * for another reason must not be mistaken for one that was never written.
 */
export function object(key: string, remote: boolean): string | undefined {
  try {
    return execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, remote ? "--remote" : "--local", "--pipe"], {
      encoding: "utf8",
      cwd: SCRAPER,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_OBJECT_BYTES,
    });
  } catch (error) {
    const err = error as { stderr?: string | Buffer; code?: string; message?: string };
    const stderr = err.stderr?.toString() ?? "";
    if (/not found|does not exist|NoSuchKey|The specified key/i.test(stderr)) return undefined;
    if (err.code === "ENOBUFS") throw new Error(`${key}: larger than ${MAX_OBJECT_BYTES} bytes`);
    if (!stderr.trim()) return undefined;
    throw new Error(`${key}: ${stderr.trim().split("\n").slice(0, 3).join(" ")}`);
  }
}

export interface Crawl {
  sightings: Sighting[];
  guesses: Map<string, Guess>;
  /** Pages the manifest named that could not be read, so a partial read is never silent. */
  missingPages: string[];
}

const pageKey = (prefix: string, page: number) => `${prefix}/page-${String(page).padStart(4, "0")}.jsonl`;

/**
 * Read one seller's crawl and whatever the classifier made of it. Guesses are keyed by seller and
 * product id together, because two shops number their products independently.
 */
export function readCrawl(seller: string, date: string, remote: boolean): Crawl | undefined {
  const prefix = `sightings/${seller}/${date}`;
  const manifest = object(`${prefix}/manifest.json`, remote);
  if (!manifest) return undefined;
  const pages = (JSON.parse(manifest) as { pages: { page: number }[] }).pages.map((p) => p.page);
  const missingPages: string[] = [];
  const sightings: Sighting[] = [];
  for (const page of pages) {
    const body = object(pageKey(prefix, page), remote);
    if (body === undefined) {
      missingPages.push(pageKey(prefix, page));
      continue;
    }
    for (const line of body.split("\n").filter(Boolean)) sightings.push(Sighting.parse(JSON.parse(line)));
  }

  const guesses = new Map<string, Guess>();
  const guessPrefix = `guesses/${seller}/${date}/${classifierKey()}`;
  if (object(`${guessPrefix}/manifest.json`, remote)) {
    for (const page of pages) {
      const body = object(pageKey(guessPrefix, page), remote);
      for (const line of (body ?? "").split("\n").filter(Boolean)) {
        const guess = Guess.parse(JSON.parse(line));
        guesses.set(`${guess.seller}/${guess.productId}`, guess);
      }
    }
  }
  return { sightings, guesses, missingPages };
}

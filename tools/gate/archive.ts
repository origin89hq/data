import { execFileSync } from "node:child_process";
import { Sighting } from "../../schema/sighting.ts";
import { Guess } from "../../schema/guess.ts";
import { classifierKey } from "../../scraper/src/classify.ts";

const BUCKET = "offgrid-equipment-archive";
const SCRAPER = new URL("../../scraper/", import.meta.url).pathname;

/** Read one object out of the crawl archive through wrangler, which owns the credentials. */
export function object(key: string, remote: boolean): string | undefined {
  try {
    return execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, remote ? "--remote" : "--local", "--pipe"], {
      encoding: "utf8",
      cwd: SCRAPER,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
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

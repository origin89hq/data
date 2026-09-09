import { readFileSync } from "node:fs";
import { Sighting } from "../../schema/sighting.ts";
import { Guess } from "../../schema/guess.ts";
import { classifierKey } from "../../scraper/src/classify.ts";

/**
 * Read a crawl back through the Worker rather than one object at a time. The first version of
 * this shelled out to wrangler once per part, which spent a second of process startup per file
 * and took longer to read a run than to produce it. R2 can list and the Worker can stream, so a
 * whole run is one request.
 *
 * `OFFGRID_BASE_URL` and `OFFGRID_CONTROL_TOKEN` point it at a deployment; without them it talks
 * to `wrangler dev` and reads the local token.
 */
const DEV_URL = "http://localhost:8790";

function base(remote: boolean): string {
  const configured = process.env.OFFGRID_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (remote) throw new Error("set OFFGRID_BASE_URL to the deployed Worker to read the remote archive");
  return DEV_URL;
}

function token(): string {
  const configured = process.env.OFFGRID_CONTROL_TOKEN;
  if (configured) return configured;
  try {
    const vars = readFileSync(new URL("../../scraper/.dev.vars", import.meta.url), "utf8");
    const match = /^CONTROL_TOKEN=(.*)$/m.exec(vars);
    if (match) return match[1].trim();
  } catch {
    // Falls through to the error below, which says what to set.
  }
  throw new Error("set OFFGRID_CONTROL_TOKEN, or put CONTROL_TOKEN in scraper/.dev.vars for local reads");
}

async function get(path: string, remote: boolean): Promise<Response> {
  const response = await fetch(`${base(remote)}${path}`, { headers: { authorization: `Bearer ${token()}` } });
  if (response.status === 404) return response;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response;
}

/** One object, or nothing when it is not there. */
export async function object(key: string, remote: boolean): Promise<string | undefined> {
  const response = await get(`/archive?prefix=${encodeURIComponent(key)}`, remote);
  if (response.status === 404) return undefined;
  const text = await response.text();
  return text.trim() ? text : undefined;
}

/** Every object under a prefix, concatenated in key order, one request. */
export async function under(prefix: string, remote: boolean): Promise<string> {
  const response = await get(`/archive?prefix=${encodeURIComponent(prefix)}`, remote);
  return response.status === 404 ? "" : await response.text();
}

export async function keysUnder(prefix: string, remote: boolean): Promise<string[]> {
  const response = await get(`/archive?prefix=${encodeURIComponent(prefix)}&list=true`, remote);
  if (response.status === 404) return [];
  return ((await response.json()) as { keys: string[] }).keys;
}

export interface Crawl {
  sightings: Sighting[];
  guesses: Map<string, Guess>;
  /** Parts the manifest expected that are not written, so a partial read is never silent. */
  missingParts: string[];
}

/** Read one seller's crawl and whatever the classifier made of it. */
export async function readCrawl(seller: string, date: string, remote: boolean): Promise<Crawl | undefined> {
  const prefix = `sightings/${seller}/${date}`;
  const manifest = await object(`${prefix}/manifest.json`, remote);
  if (!manifest) return undefined;
  const pages = (JSON.parse(manifest) as { pages: { page: number }[] }).pages.map((p) => p.page);

  const sightings: Sighting[] = [];
  for (const line of (await under(`${prefix}/page-`, remote)).split("\n").filter(Boolean)) {
    sightings.push(Sighting.parse(JSON.parse(line)));
  }

  const guessPrefix = `guesses/${seller}/${date}/${classifierKey()}`;
  const guesses = new Map<string, Guess>();
  const missingParts: string[] = [];
  const guessManifest = await object(`${guessPrefix}/manifest.json`, remote);
  if (guessManifest) {
    const { parts } = JSON.parse(guessManifest) as { parts: number };
    const written = new Set((await keysUnder(`${guessPrefix}/page-`, remote)).map((k) => k.split("/").pop()));
    for (let part = 1; part <= parts; part += 1) {
      if (!written.has(`page-${String(part).padStart(4, "0")}.jsonl`)) missingParts.push(`part ${part}`);
    }
    for (const line of (await under(`${guessPrefix}/page-`, remote)).split("\n").filter(Boolean)) {
      const guess = Guess.parse(JSON.parse(line));
      guesses.set(`${guess.seller}/${guess.productId}`, guess);
    }
  }
  // Pages are read by prefix rather than by number, so a page the manifest named and the store
  // does not hold shows up as a shortfall in the count rather than as a silently shorter answer.
  if (pages.length > 0 && sightings.length === 0) missingParts.push("every sightings page");
  return { sightings, guesses, missingParts };
}

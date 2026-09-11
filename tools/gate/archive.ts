import { Guess } from "@origin89/equipment-schema/guess";
import {
  classifierKey,
  EXTRACTOR_ID,
  PULL_PAGE_READER,
  READS_PER_REQUEST,
  readerKey,
  VISION_EXTRACTOR_ID,
} from "@origin89/equipment-schema/provenance";
import { Sighting } from "@origin89/equipment-schema/sighting";
import type { MakerState } from "../../apps/worker/src/state.ts";
import { bearerFor } from "../credential.ts";

/**
 * Read a crawl back through the Worker rather than one object at a time. The first version of
 * this shelled out to wrangler once per part, which spent a second of process startup per file
 * and took longer to read a run than to produce it. R2 can list and the Worker can stream, so a
 * whole run is one request.
 *
 * `OFFGRID_BASE_URL` points it at a deployment, with the sign-in from `just login`; without it,
 * it talks to `wrangler dev` with the local control token.
 */
const DEV_URL = "http://localhost:8790";

function base(remote: boolean): string {
  const configured = process.env.OFFGRID_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (remote)
    throw new Error("set OFFGRID_BASE_URL to the deployed Worker to read the remote archive");
  return DEV_URL;
}

async function get(path: string, remote: boolean): Promise<Response> {
  const response = await fetch(`${base(remote)}${path}`, {
    headers: { authorization: `Bearer ${await bearerFor(base(remote))}` },
  });
  if (response.status === 404) return response;
  if (!response.ok)
    throw new Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response;
}

async function post(path: string, body: unknown, remote: boolean): Promise<Response> {
  const response = await fetch(`${base(remote)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await bearerFor(base(remote))}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
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

/**
 * Parse a stream of JSON values that may or may not be one per line. Objects written pretty
 * spread over many lines, and splitting on newlines silently drops all of them; reading value by
 * value works for both and cannot half-read one.
 */
export function jsonValues<T>(text: string): T[] {
  const out: T[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    // JSON.parse cannot resume, so the end of each value is found by trying to parse the
    // shortest balanced prefix. Values here are objects, so brace depth outside strings is enough.
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = index;
    for (; end < text.length; end += 1) {
      const c = text[end];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = !inString;
      else if (!inString && (c === "{" || c === "[")) depth += 1;
      else if (!inString && (c === "}" || c === "]")) {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (depth !== 0) throw new Error("unbalanced JSON in the archive stream");
    out.push(JSON.parse(text.slice(index, end)) as T);
    index = end;
  }
  return out;
}

export async function keysUnder(prefix: string, remote: boolean): Promise<string[]> {
  const response = await get(`/archive?prefix=${encodeURIComponent(prefix)}&list=true`, remote);
  if (response.status === 404) return [];
  return ((await response.json()) as { keys: string[] }).keys;
}

/** Where every maker's current run got to, as the Worker works it out from the archive. */
export async function makerStates(remote: boolean): Promise<MakerState[]> {
  const response = await get("/state", remote);
  // `get` lets a 404 through because in the archive it means an object is absent. Here it means
  // the base URL is not this Worker, which is worth saying rather than failing to parse a body.
  if (response.status === 404) {
    throw new Error(`${base(remote)}/state answered 404; is OFFGRID_BASE_URL this Worker?`);
  }
  return ((await response.json()) as { makers: MakerState[] }).makers;
}

/** Which run is current for an entity, so a reader never has to guess from a date. */
export async function currentRun(
  root: "documents" | "sightings",
  entity: string,
  remote: boolean,
): Promise<{ run: string; date: string } | undefined> {
  const body = await object(`${root}/${entity}/current.json`, remote);
  return body ? (JSON.parse(body) as { run: string; date: string }) : undefined;
}

export interface Crawl {
  sightings: Sighting[];
  guesses: Map<string, Guess>;
  /**
   * What a whole crawl has and this one lacks: a classification, parts its manifest expects, or
   * sightings pages. A partial read is never silent.
   */
  missingParts: string[];
}

/** Read one seller's crawl and whatever the classifier made of it. */
export async function readCrawl(
  seller: string,
  date: string,
  remote: boolean,
): Promise<Crawl | undefined> {
  const current = await currentRun("sightings", seller, remote);
  if (!current) return undefined;
  if (current.date !== date) {
    throw new Error(
      `${seller}: current crawl is dated ${current.date}, requested ${date}; refusing to read a different crawl`,
    );
  }
  const prefix = `sightings/${seller}/runs/${current.run}`;
  const manifest = await object(`${prefix}/manifest.json`, remote);
  if (!manifest) return undefined;
  const pages = (JSON.parse(manifest) as { pages: { page: number }[] }).pages.map((p) => p.page);

  const sightings: Sighting[] = [];
  for (const line of (await under(`${prefix}/page-`, remote)).split("\n").filter(Boolean)) {
    sightings.push(Sighting.parse(JSON.parse(line)));
  }

  const guessPrefix = `guesses/${seller}/runs/${current.run}/${classifierKey()}`;
  const guesses = new Map<string, Guess>();
  const missingParts: string[] = [];
  const guessManifest = await object(`${guessPrefix}/manifest.json`, remote);
  if (!guessManifest) {
    // A run not classified yet, or one being classified again: the Worker deletes the manifest
    // first and writes it after every part is sent. Read as a whole crawl with no guesses, it
    // replaced a brand's evidence with none.
    missingParts.push("no classification yet");
  } else {
    const { parts, alreadyAnswered } = JSON.parse(guessManifest) as {
      parts: number;
      alreadyAnswered?: number;
    };
    // A classification from before #16 left out the listings answered on an earlier run, so its
    // parts are whole and its guesses still short. The supervisor classifies such a run again.
    if (alreadyAnswered)
      missingParts.push(`${alreadyAnswered} listings answered on an earlier run`);
    const written = new Set(
      (await keysUnder(`${guessPrefix}/page-`, remote)).map((k) => k.split("/").pop()),
    );
    for (let part = 1; part <= parts; part += 1) {
      if (!written.has(`page-${String(part).padStart(4, "0")}.jsonl`))
        missingParts.push(`part ${part}`);
    }
    for (const line of (await under(`${guessPrefix}/page-`, remote)).split("\n").filter(Boolean)) {
      const guess = Guess.parse(JSON.parse(line));
      guesses.set(`${guess.seller}/${guess.productId}`, guess);
    }
  }
  const sightingKeys = new Set(await keysUnder(`${prefix}/page-`, remote));
  for (const page of pages) {
    const key = `${prefix}/page-${String(page).padStart(4, "0")}.jsonl`;
    if (!sightingKeys.has(key)) missingParts.push(`sightings page ${page}`);
  }
  return { sightings, guesses, missingParts };
}

/**
 * The readers whose figures the pull takes: the text reader, the parser over a maker's own
 * specification tables, and the page reader only when `PULL_PAGE_READER` lets it in.
 */
export const PULLED_READERS: readonly string[] = [
  readerKey(EXTRACTOR_ID),
  ...(PULL_PAGE_READER ? [readerKey(VISION_EXTRACTOR_ID)] : []),
  "table_spec-table_v1",
];

/**
 * Every reading of these documents, in one request per batch.
 *
 * Readings are addressed by the bytes they read, so a maker's are scattered across a flat prefix
 * with nothing to stream by. Fetching them one at a time was a round trip each, which for four
 * thousand documents across three readers is thirteen thousand of them — the daily pull spent
 * twenty-eight minutes on it and was climbing.
 *
 * The batch is sized from the Worker's own cap, so the two cannot disagree about it: a request
 * over the cap is refused there rather than trimmed, and a trimmed answer would have looked like
 * documents nobody had read.
 */
export async function readingsOf(
  documents: readonly string[],
  readers: readonly string[],
  remote: boolean,
): Promise<string> {
  // No readers divides by nothing and asks for every document in one request; more readers than
  // the cap sizes every batch at one and has each refused in turn. Both are a mistake at the call
  // site, and both would otherwise be reported by the Worker, a long way from the line that made
  // them.
  if (readers.length === 0 || readers.length > READS_PER_REQUEST)
    throw new Error(`readingsOf needs 1 to ${READS_PER_REQUEST} readers, not ${readers.length}`);
  const perRequest = Math.floor(READS_PER_REQUEST / readers.length);
  let ndjson = "";
  for (let i = 0; i < documents.length; i += perRequest) {
    const response = await post(
      "/readings",
      { documents: documents.slice(i, i + perRequest), readers },
      remote,
    );
    ndjson += await response.text();
  }
  return ndjson;
}

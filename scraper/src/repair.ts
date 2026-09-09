import { todayUtc } from "./feeds.ts";

/**
 * Put the archive's dates right.
 *
 * Runs are addressed by a date, and I was picking that date loosely so a second run of the same
 * maker on the same day would not overwrite the first. The label then went into the objects as
 * `checkedAt`, so the biggest run in this bucket is filed under a day that has not happened and
 * says so inside every manifest.
 *
 * Two things are wrong and both are fixed here: the fields, which are read as facts, and the
 * prefix, which anybody browsing the bucket reads as a date. A same-day re-run overwrites, which
 * is what it should always have done — a crawl of a shop today replaces this morning's crawl of it.
 */
/** How many objects one call touches. A whole archive in one request would run out of CPU. */
export const REPAIR_BATCH = 300;

export interface RepairReport {
  today: string;
  dry: boolean;
  /** Objects looked at this call, and where to carry on from. */
  examined: number;
  done: boolean;
  nextAfter?: string;
  /** Objects whose stored dates were in the future. */
  fields: { key: string; from: string }[];
  /** Objects moved from a label that never happened to the day they ran. */
  moved: { from: string; to: string }[];
  /** Objects a move would have overwritten, kept so nothing is lost silently. */
  overwritten: string[];
  concerns: string[];
}

const DATE_IN_PATH = /\/(\d{4}-\d{2}-\d{2})\//;

/** Every date-shaped value in an object, corrected when it is after today. */
function correct(value: unknown, today: string, changed: { any: boolean }): unknown {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && value > today) {
      changed.any = true;
      return today;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => correct(v, today, changed));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, correct(v, today, changed)]));
  }
  return value;
}

async function keysUnder(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function repairDates(env: Env, dry: boolean, after?: string): Promise<RepairReport> {
  const today = todayUtc();
  const report: RepairReport = { today, dry, examined: 0, done: false, fields: [], moved: [], overwritten: [], concerns: [] };

  const all: string[] = [];
  for (const root of ["sightings/", "documents/", "guesses/", "supervision/"]) all.push(...(await keysUnder(env.ARCHIVE, root)));
  all.sort();
  const start = after ? all.findIndex((k) => k > after) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + REPAIR_BATCH);
  report.done = start < 0 || start + slice.length >= all.length;
  if (slice.length > 0) report.nextAfter = slice[slice.length - 1];

  {
    for (const key of slice) {
      report.examined += 1;
      const label = DATE_IN_PATH.exec(key)?.[1];
      const stale = label !== undefined && label > today;
      const target = stale ? key.replace(`/${label}/`, `/${today}/`) : key;

      const object = await env.ARCHIVE.get(key);
      if (!object) continue;

      let body: string | ArrayBuffer = await object.arrayBuffer();
      if (key.endsWith(".json") || key.endsWith(".jsonl")) {
        const text = new TextDecoder().decode(body as ArrayBuffer);
        const changed = { any: false };
        try {
          // JSONL is many values; JSON is one. Both are corrected line by line, so a page of
          // sightings does not have to be parsed as a single document.
          const fixed = text
            .split("\n")
            .map((line) => (line.trim() ? JSON.stringify(correct(JSON.parse(line), today, changed)) : line))
            .join("\n");
          if (changed.any) {
            report.fields.push({ key, from: label ?? "inside" });
            body = fixed;
          }
        } catch (error) {
          // One object that will not parse is one object. Stopping the repair of the other
          // eighteen hundred because of it is how a fix becomes a second outage.
          report.concerns.push(`${key}: not readable as JSON (${error instanceof Error ? error.message.slice(0, 60) : "unknown"}); left as it is`);
          continue;
        }
      }

      if (stale) {
        if (await env.ARCHIVE.head(target)) report.overwritten.push(target);
        report.moved.push({ from: key, to: target });
      }
      if (dry) continue;

      const write = typeof body === "string" ? body : new Uint8Array(body as ArrayBuffer);
      if (stale || typeof body === "string") {
        await env.ARCHIVE.put(target, write, { httpMetadata: object.httpMetadata });
      }
      // The old key goes only once the new one is written, so a failure halfway leaves two copies
      // rather than none.
      if (stale && (await env.ARCHIVE.head(target))) await env.ARCHIVE.delete(key);
      else if (stale) report.concerns.push(`${target} did not appear after writing; ${key} left alone`);
    }
  }
  console.log(JSON.stringify({ message: "date repair", dry, fields: report.fields.length, moved: report.moved.length, overwritten: report.overwritten.length }));
  return report;
}

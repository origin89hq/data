import {
  byId,
  type CompareQuery,
  type Comparison,
  canonical,
  changedFields,
  type FileMeta,
  type RecordKind,
  Release,
  releaseContent,
  SNAPSHOT_PART_MAX,
  SNAPSHOT_PART_ROWS,
  snapshotName,
} from "@origin89/equipment-schema/releases";
import { z } from "zod";
import { digest, noteActivity, reverseTime } from "./activity.ts";

export class HistoryUnavailable extends Error {}
export const snapshotKey = (sha: string) => `releases/snapshots/${sha}.json`;
/** A load part by its content, so a loader reads the bytes the manifest named whatever was published since. */
export const loadKey = (sha: string) => `releases/loads/${sha}.ndjson`;
export const releaseKey = (id: string) => `releases/versions/${id}.json`;
export async function saveRelease(
  bucket: R2Bucket,
  files: Release["files"],
  sha: string,
  job: string,
  attempt = "1",
  plans: Pick<Release, "load" | "snapshots"> = {},
) {
  const content = await releaseContent(files);
  // A retry within one job attempt is the same publication. Another job or rerun is a new
  // occurrence, even when it restores older content. Snapshot bytes still deduplicate by hash.
  const id = await digest(`${content}:${sha}:${job}:${attempt}`);
  const release = Release.parse({
    id,
    content,
    attempt,
    at: new Date().toISOString(),
    sha,
    job,
    files,
    ...(plans.load ? { load: plans.load } : {}),
    ...(plans.snapshots ? { snapshots: plans.snapshots } : {}),
  });
  const written = await bucket.put(releaseKey(id), JSON.stringify(release), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written ? release : await getRelease(bucket, id);
}
export async function indexRelease(bucket: R2Bucket, release: Release) {
  await bucket.put(
    `releases/feed/${reverseTime(release.at)}-${release.id}.json`,
    JSON.stringify(release),
  );
  await noteActivity(bucket, {
    id: `release:${release.id}`,
    at: release.at,
    kind: "release",
    entity: "Dataset",
    actor: `publish.yml run ${release.job}`,
    summary: `Dataset published · ${release.id.slice(0, 12)}`,
    release: release.id,
  });
}
export async function getRelease(bucket: R2Bucket, id: string): Promise<Release> {
  const object = await bucket.get(releaseKey(id));
  if (!object) throw new HistoryUnavailable("This dataset version has not been recorded.");
  try {
    return Release.parse(await object.json());
  } catch {
    throw new HistoryUnavailable("The release metadata is malformed.");
  }
}
export async function releasePage(bucket: R2Bucket, cursor?: string) {
  const page = await bucket.list({ prefix: "releases/feed/", limit: 20, cursor });
  const releases: Release[] = [];
  for (const item of page.objects) {
    const object = await bucket.get(item.key);
    if (!object) throw new HistoryUnavailable("A release entry is unavailable.");
    try {
      releases.push(Release.parse(await object.json()));
    } catch {
      throw new HistoryUnavailable("A release history entry is malformed.");
    }
  }
  return { releases, cursor: page.truncated ? page.cursor : undefined };
}
/** Before snapshots had parts, a kind was one file of at most this many bytes and records. */
const WHOLE_SNAPSHOT_MAX = 6 * 1024 * 1024;
const WHOLE_SNAPSHOT_ROWS = 50_000;
type SnapshotRecord = { id: string } & Record<string, unknown>;
const snapshotRecords = (rows: number) =>
  z.array(z.object({ id: z.string().min(1) }).catchall(z.unknown())).max(rows);

async function snapshotFile(
  bucket: R2Bucket,
  meta: z.infer<typeof FileMeta> | undefined,
  bytes: number,
  rows: number,
): Promise<SnapshotRecord[]> {
  if (!meta) throw new HistoryUnavailable("The release names a snapshot part it does not list.");
  if (meta.bytes > bytes)
    throw new HistoryUnavailable(
      "This record snapshot exceeds the comparison limit. Use the source comparison.",
    );
  const object = await bucket.get(snapshotKey(meta.sha256));
  if (!object || object.size !== meta.bytes)
    throw new HistoryUnavailable("The immutable record snapshot is unavailable.");
  try {
    return snapshotRecords(rows).parse(await object.json());
  } catch {
    throw new HistoryUnavailable(
      `The record snapshot is malformed or exceeds the ${rows.toLocaleString("en")}-record limit of a snapshot file.`,
    );
  }
}

/**
 * A release's records of one kind in id order, one snapshot part in memory at a time. A release
 * published before snapshots had parts has one whole snapshot, sorted here. Records out of order,
 * a repeated id, or parts holding other than the records the release states end the walk with an
 * error rather than a partial comparison.
 */
async function* records(
  bucket: R2Bucket,
  release: Release,
  kind: z.infer<typeof RecordKind>,
): AsyncGenerator<SnapshotRecord, void> {
  let last: string | undefined;
  const inOrder = function* (part: SnapshotRecord[]) {
    for (const record of part) {
      if (last !== undefined && !(last < record.id))
        throw new HistoryUnavailable(
          last === record.id
            ? "The snapshot contains duplicate record IDs."
            : "The snapshot's records are out of ID order.",
        );
      last = record.id;
      yield record;
    }
  };
  const plan = release.snapshots?.kinds[kind];
  if (!plan) {
    const meta = release.files[snapshotName(kind)];
    if (!meta)
      throw new HistoryUnavailable(
        "This version predates record snapshots. File comparison remains available from its manifest.",
      );
    const whole = await snapshotFile(bucket, meta, WHOLE_SNAPSHOT_MAX, WHOLE_SNAPSHOT_ROWS);
    yield* inOrder(whole.sort(byId));
    return;
  }
  let rows = 0;
  for (const name of plan.parts) {
    const part = await snapshotFile(
      bucket,
      release.files[name],
      SNAPSHOT_PART_MAX,
      SNAPSHOT_PART_ROWS,
    );
    rows += part.length;
    yield* inOrder(part);
  }
  if (rows !== plan.rows)
    throw new HistoryUnavailable(
      `The snapshot parts hold ${rows} records; the release states ${plan.rows}.`,
    );
}
export async function compareReleases(
  bucket: R2Bucket,
  query: z.infer<typeof CompareQuery>,
): Promise<Comparison> {
  const from = await getRelease(bucket, query.from),
    to = await getRelease(bucket, query.to);
  // Both sides are in id order, so one walk pairs each id with its record on either side.
  const before = records(bucket, from, query.kind),
    after = records(bucket, to, query.kind);
  const counts = { added: 0, removed: 0, changed: 0 };
  const changes: Comparison["changes"] = [];
  let matched = 0;
  let x = await before.next(),
    y = await after.next();
  for (;;) {
    const was = x.done ? undefined : x.value,
      now = y.done ? undefined : y.value;
    let id: string, a: SnapshotRecord | undefined, b: SnapshotRecord | undefined;
    if (was && (!now || was.id < now.id)) [id, a] = [was.id, was];
    else if (now && (!was || now.id < was.id)) [id, b] = [now.id, now];
    else if (was && now) [id, a, b] = [was.id, was, now];
    else break;
    if (a) x = await before.next();
    if (b) y = await after.next();
    const fields = changedFields(a ?? {}, b ?? {});
    if (a && b && fields.length === 0) continue;
    const change = !a ? "added" : !b ? "removed" : "changed";
    counts[change]++;
    if (
      !id.toLowerCase().includes(query.q.toLowerCase()) ||
      (query.change !== "all" && change !== query.change)
    )
      continue;
    if (matched >= query.offset && changes.length < query.limit)
      changes.push({ id, change, fields, before: a, after: b });
    matched++;
  }
  const files: Comparison["files"] = [];
  for (const name of [...new Set([...Object.keys(from.files), ...Object.keys(to.files)])].sort()) {
    const a = from.files[name],
      b = to.files[name];
    if (canonical(a) === canonical(b)) continue;
    files.push({ name, change: !a ? "added" : !b ? "removed" : "changed", before: a, after: b });
  }
  return {
    from,
    to,
    kind: query.kind,
    counts,
    total: counts.added + counts.removed + counts.changed,
    matched,
    changes,
    next: query.offset + changes.length < matched ? query.offset + changes.length : undefined,
    files,
  };
}

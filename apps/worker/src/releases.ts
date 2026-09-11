import {
  type CompareQuery,
  type Comparison,
  canonical,
  changedFields,
  RECORD_SNAPSHOT_MAX,
  type RecordKind,
  Release,
  snapshotName,
} from "@origin89/equipment-schema/releases";
import { z } from "zod";
import { digest, noteActivity, reverseTime } from "./activity.ts";

export class HistoryUnavailable extends Error {}
export const snapshotKey = (sha: string) => `releases/snapshots/${sha}.json`;
/** A load part by its content, so a loader reads the bytes the manifest named whatever was published since. */
export const loadKey = (sha: string) => `releases/loads/${sha}.ndjson`;
const releaseKey = (id: string) => `releases/versions/${id}.json`;
export async function saveRelease(
  bucket: R2Bucket,
  files: Release["files"],
  sha: string,
  job: string,
  attempt = "1",
) {
  const content = await digest(canonical(files));
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
const Snapshot = z.array(z.object({ id: z.string().min(1) }).catchall(z.unknown())).max(50000);
async function records(bucket: R2Bucket, release: Release, kind: z.infer<typeof RecordKind>) {
  const meta = release.files[snapshotName(kind)];
  if (!meta)
    throw new HistoryUnavailable(
      "This version predates record snapshots. File comparison remains available from its manifest.",
    );
  if (meta.bytes > RECORD_SNAPSHOT_MAX)
    throw new HistoryUnavailable(
      "This record snapshot exceeds the comparison limit. Use the source comparison.",
    );
  const object = await bucket.get(snapshotKey(meta.sha256));
  if (!object || object.size !== meta.bytes)
    throw new HistoryUnavailable("The immutable record snapshot is unavailable.");
  let parsed: z.infer<typeof Snapshot>;
  try {
    parsed = Snapshot.parse(await object.json());
  } catch {
    throw new HistoryUnavailable(
      "The record snapshot is malformed or exceeds the 50,000-record comparison limit.",
    );
  }
  const index = new Map(parsed.map((record) => [record.id, record]));
  if (index.size !== parsed.length)
    throw new HistoryUnavailable("The snapshot contains duplicate record IDs.");
  return index;
}
export async function compareReleases(
  bucket: R2Bucket,
  query: z.infer<typeof CompareQuery>,
): Promise<Comparison> {
  const from = await getRelease(bucket, query.from),
    to = await getRelease(bucket, query.to);
  const before = await records(bucket, from, query.kind),
    after = await records(bucket, to, query.kind);
  const counts = { added: 0, removed: 0, changed: 0 };
  const changes: Comparison["changes"] = [];
  let matched = 0;
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(id),
      b = after.get(id);
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

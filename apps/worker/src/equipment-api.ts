import {
  type Bundle,
  type BundleQuery,
  type Claim,
  CONTRACT,
  type DialectSummary,
  type Gap,
  keyPart,
  LIMITS,
  type ModelSummary,
  makerKey,
  modelKey,
  nameKey,
  type Page,
  type PropertyDefinition,
  type ReleaseInfo,
  type Resolution,
  type ResolveQuery,
  type SearchQuery,
  type Source,
} from "@origin89/equipment-api";
import { createSchema, type Store } from "./release-store.ts";

/**
 * The answers behind the EquipmentApi, each over one release of the store (#83). Every function
 * here takes the release id it answers for, so nothing can mix two releases in one answer, and
 * every list is cut at a limit the contract states, with the cut said out loud.
 */

/**
 * The store's tables, created once per isolate before the first answer. A reader deployed ahead
 * of the next publication would otherwise ask a table the load Workflow has not created yet.
 */
const ensured = new WeakMap<Store, Promise<boolean>>();
export function ensureSchema(db: Store): Promise<boolean> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = createSchema(db)
      .then((reset) => Boolean(reset))
      .catch((error) => {
        ensured.delete(db);
        throw error;
      });
    ensured.set(db, pending);
  }
  return pending;
}

export class NoSuchRelease extends Error {
  override name = "NoSuchRelease";
}

/** The release a consumer gets when it names none: the active one. */
export async function currentRelease(db: Store): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM releases WHERE state = 'active'")
    .first<{ id: string }>();
  if (!row) throw new NoSuchRelease("no release is loaded yet");
  return row.id;
}

/** A release the store holds and can answer for: active or retained, never one still loading or failed. */
export async function loadedRelease(db: Store, id: string): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM releases WHERE id = ? AND state IN ('active', 'retained')")
    .bind(id)
    .first<{ id: string }>();
  if (!row) throw new NoSuchRelease(`release ${id} is not loaded`);
  return row.id;
}

export async function releaseInfo(db: Store, release: string): Promise<ReleaseInfo> {
  const row = await db
    .prepare("SELECT id, content, published_at, counts FROM releases WHERE id = ?")
    .bind(release)
    .first<{ id: string; content: string; published_at: string; counts: string }>();
  if (!row) throw new NoSuchRelease(`release ${release} is not loaded`);
  return {
    id: row.id,
    content: row.content,
    publishedAt: row.published_at,
    contract: CONTRACT,
    counts: JSON.parse(row.counts) as Record<string, number>,
  };
}

type ModelRow = { id: string; row: string };

/** How many ids one `IN (...)` may carry beside the release: D1 binds at most 100 parameters. */
const IDS_PER_QUERY = 90;
const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += IDS_PER_QUERY)
    out.push(items.slice(at, at + IDS_PER_QUERY));
  return out;
};

/** A LIKE pattern that matches the text as a prefix, with `%`, `_` and `\` escaped rather than dropped. */
export const likePrefix = (text: string): string => `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const ESCAPE = "ESCAPE '\\'";

/** Rows of `sql` for every chunk of `ids`, bound after the release. */
async function inChunks<T>(
  db: Store,
  release: string,
  ids: readonly string[],
  sql: (marks: string) => string,
): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of chunks(ids)) {
    const marks = chunk.map(() => "?").join(", ");
    out.push(
      ...(
        await db
          .prepare(sql(marks))
          .bind(release, ...chunk)
          .all<T>()
      ).results,
    );
  }
  return out;
}

const summary = (
  row: string,
  aliases: string[],
  makers: ReadonlyMap<string, string>,
): ModelSummary => {
  const m = JSON.parse(row) as Record<string, string | undefined>;
  return {
    id: m.id ?? "",
    tier: m.tier === "feed" ? "feed" : "record",
    manufacturer: {
      ...(m.manufacturer_id ? { id: m.manufacturer_id } : {}),
      // A record model carries only its maker's id; the name is the maker record's.
      name:
        m.manufacturer_name ??
        (m.manufacturer_id ? makers.get(m.manufacturer_id) : undefined) ??
        m.manufacturer_id ??
        "",
    },
    name: m.name ?? "",
    ...(m.kind ? { kind: m.kind as ModelSummary["kind"] } : {}),
    ...(m.variant ? { variant: m.variant } : {}),
    ...(m.family ? { family: m.family } : {}),
    aliases,
    ...(m.reviewed_by ? { reviewedBy: m.reviewed_by } : {}),
  };
};

/** Models by id, in the order asked, each with its aliases; ids the release lacks are left out. */
export async function modelsById(
  db: Store,
  release: string,
  ids: readonly string[],
): Promise<ModelSummary[]> {
  if (ids.length === 0) return [];
  const rows = await inChunks<ModelRow>(
    db,
    release,
    ids,
    (marks) => `SELECT id, row FROM models WHERE release = ? AND id IN (${marks})`,
  );
  const aliases = await inChunks<{ model_id: string; alias: string }>(
    db,
    release,
    ids,
    (marks) =>
      `SELECT model_id, alias FROM model_aliases WHERE release = ? AND model_id IN (${marks})`,
  );
  const byId = new Map(rows.map((r) => [r.id, r.row]));
  const makerIds = [
    ...new Set(
      rows.flatMap((r) => {
        const m = JSON.parse(r.row) as Record<string, string | undefined>;
        return m.manufacturer_id && !m.manufacturer_name ? [m.manufacturer_id] : [];
      }),
    ),
  ];
  const makers = new Map(
    (
      await inChunks<{ id: string; name: string }>(
        db,
        release,
        makerIds,
        (marks) => `SELECT id, name FROM manufacturers WHERE release = ? AND id IN (${marks})`,
      )
    ).map((m) => [m.id, m.name]),
  );
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row
      ? [
          summary(
            row,
            aliases.filter((a) => a.model_id === id).map((a) => a.alias),
            makers,
          ),
        ]
      : [];
  });
}

/** How many models sharing a key are read before a resolution gives up on counting them. */
const RESOLVE_READ = 200;

/** Distinct model ids, in first-seen order. */
const distinct = (rows: { model_id: string }[]): string[] => [
  ...new Set(rows.map((r) => r.model_id)),
];

const byKind = (models: ModelSummary[], kind?: string) =>
  kind ? models.filter((m) => m.kind === kind) : models;

/**
 * One model, several, or none. With a brand or maker the key must match whole; without, the
 * name's part is matched under every maker. A label is tried as a whole key and then as a name
 * printed after its maker. Near neighbours share the start of the name and are for showing.
 */
/** Keys joined to their models, so a kind can narrow the match in SQL before any cap. */
const KEYED =
  "SELECT k.model_id FROM model_keys k JOIN models m ON m.release = k.release AND m.id = k.model_id WHERE k.release = ?";
const OF_KIND = "AND (? IS NULL OR m.kind = ?)";

export async function resolve(db: Store, release: string, q: ResolveQuery): Promise<Resolution> {
  const kind = "kind" in q ? q.kind : undefined;
  let ids: string[];
  let stem: string;
  if ("label" in q) {
    const key = keyPart(q.label);
    stem = key;
    ids = distinct(
      (
        await db
          .prepare(
            // The whole label as a key, or a name printed after its maker, or before it.
            `${KEYED} AND (k.key = ? OR (length(k.name_key) >= 3 AND (substr(?, -length(k.name_key)) = k.name_key OR substr(?, 1, length(k.name_key)) = k.name_key))) ${OF_KIND} ORDER BY k.rowid`,
          )
          .bind(release, key, key, key, kind ?? null, kind ?? null)
          .all<{ model_id: string }>()
      ).results,
    );
  } else if (q.brand) {
    stem = nameKey(q.brand, q.model);
    ids = distinct(
      (
        await db
          .prepare(`${KEYED} AND k.key = ? ${OF_KIND} ORDER BY k.rowid`)
          .bind(release, modelKey(q.brand, q.model), kind ?? null, kind ?? null)
          .all<{ model_id: string }>()
      ).results,
    );
  } else {
    stem = keyPart(q.model);
    ids = distinct(
      (
        await db
          .prepare(`${KEYED} AND k.name_key = ? ${OF_KIND} ORDER BY k.rowid`)
          .bind(release, stem, kind ?? null, kind ?? null)
          .all<{ model_id: string }>()
      ).results,
    );
  }
  // The kind narrows before anything is counted, so a kind that singles one model out of many
  // gives `exact`, and a candidate list is cut only after it has been narrowed.
  const found = await modelsById(db, release, ids.slice(0, RESOLVE_READ));
  const overflow = ids.length > RESOLVE_READ;
  if (found.length === 1 && !overflow) {
    const only = found[0];
    if (only) return { outcome: "exact", model: only };
  }
  if (found.length > 1 || (found.length === 1 && overflow))
    return {
      outcome: "ambiguous",
      candidates: found.slice(0, LIMITS.candidates),
      truncated: overflow || found.length > LIMITS.candidates,
    };
  // Nothing whole. Neighbours by the first characters of the name, for a person to look at.
  const head = stem.slice(0, Math.max(3, Math.min(6, stem.length)));
  // One row a model however many names reach it, and the kind applied before the cut, so the
  // count is of models a person could pick from and `truncated` means what it says.
  const near =
    head.length < 3
      ? []
      : (
          await db
            .prepare(
              `SELECT model_id, MIN(name_key) AS first FROM model_keys WHERE release = ? AND name_key LIKE ? ${ESCAPE} GROUP BY model_id ORDER BY first, model_id LIMIT ?`,
            )
            .bind(release, likePrefix(head), RESOLVE_READ)
            .all<{ model_id: string }>()
        ).results.map((r) => r.model_id);
  const shown = byKind(await modelsById(db, release, near), kind);
  return {
    outcome: "none",
    near: shown.slice(0, LIMITS.candidates),
    truncated: shown.length > LIMITS.candidates || near.length >= RESOLVE_READ,
  };
}

/** The maker ids and printed maker names that answer to a brand or maker name, by its key. */
async function makersNamed(
  db: Store,
  release: string,
  brand: string,
): Promise<{ ids: string[]; names: string[] }> {
  const key = makerKey(brand);
  const makers = (
    await db
      .prepare("SELECT id, name FROM manufacturers WHERE release = ?")
      .bind(release)
      .all<{ id: string; name: string }>()
  ).results;
  const brands = (
    await db
      .prepare(
        "SELECT brand, manufacturer_id FROM brands WHERE release = ? AND decision = 'manufacturer'",
      )
      .bind(release)
      .all<{ brand: string; manufacturer_id: string | null }>()
  ).results;
  const printed = (
    await db
      .prepare(
        "SELECT DISTINCT manufacturer_name FROM models WHERE release = ? AND manufacturer_id IS NULL",
      )
      .bind(release)
      .all<{ manufacturer_name: string | null }>()
  ).results;
  const ids = new Set<string>();
  for (const m of makers) if (makerKey(m.name) === key) ids.add(m.id);
  for (const b of brands)
    if (b.manufacturer_id && makerKey(b.brand) === key) ids.add(b.manufacturer_id);
  const names = printed.flatMap((p) =>
    p.manufacturer_name && makerKey(p.manufacturer_name) === key ? [p.manufacturer_name] : [],
  );
  return { ids: [...ids], names };
}

/** Models by maker, name prefix and kind, a page at a time, ordered by name then id. */
export async function search(
  db: Store,
  release: string,
  q: SearchQuery,
): Promise<Page<ModelSummary>> {
  // The cursor is checked before anything else, so a cursor from another search is refused
  // even when the search itself would have matched nothing.
  const after = q.cursor ? splitCursor(q.cursor, scopeOf(release, q)) : undefined;
  const where: string[] = ["release = ?"];
  const params: (string | number)[] = [release];
  if (q.brand) {
    const { ids, names } = await makersNamed(db, release, q.brand);
    if (ids.length === 0 && names.length === 0) return { items: [], truncated: false };
    const clauses: string[] = [];
    if (ids.length) {
      clauses.push(`manufacturer_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    if (names.length) {
      clauses.push(
        `(manufacturer_id IS NULL AND manufacturer_name IN (${names.map(() => "?").join(", ")}))`,
      );
      params.push(...names);
    }
    where.push(`(${clauses.join(" OR ")})`);
  }
  if (q.prefix) {
    where.push(
      `id IN (SELECT model_id FROM model_keys WHERE release = ? AND name_key LIKE ? ${ESCAPE})`,
    );
    params.push(release, likePrefix(keyPart(q.prefix)));
  }
  if (q.kind) {
    where.push("kind = ?");
    params.push(q.kind);
  }
  if (after) {
    const [name, id] = after;
    where.push("(name > ? OR (name = ? AND id > ?))");
    params.push(name, name, id);
  }
  const rows = (
    await db
      .prepare(`SELECT id, name FROM models WHERE ${where.join(" AND ")} ORDER BY name, id LIMIT ?`)
      .bind(...params, q.limit + 1)
      .all<{ id: string; name: string }>()
  ).results;
  const page = rows.slice(0, q.limit);
  const items = await modelsById(
    db,
    release,
    page.map((r) => r.id),
  );
  const last = page[page.length - 1];
  const truncated = rows.length > q.limit;
  return {
    items,
    ...(truncated && last ? { cursor: joinCursor(last.name, last.id, scopeOf(release, q)) } : {}),
    truncated,
  };
}

/**
 * A cursor is the last row's name and id, bound to the release and the query it was given out
 * for, so one copied from another search, another release or made up by hand is refused
 * rather than skipping rows quietly.
 */
const scopeOf = (release: string, q: SearchQuery): string =>
  `${release}|${q.brand ?? ""}|${q.prefix ?? ""}|${q.kind ?? ""}`;
/** The digest covers the boundary as well as the scope: an edited name or id is not ours either. */
const stamp = (scope: string, name: string, id: string): string => fnv1a(`${scope}|${name}|${id}`);
const joinCursor = (name: string, id: string, scope: string): string =>
  JSON.stringify([name, id, stamp(scope, name, id)]);
const splitCursor = (cursor: string, scope: string): [string, string] => {
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      parsed[2] === stamp(scope, parsed[0], parsed[1])
    )
      return [parsed[0], parsed[1]];
  } catch {
    // fall through
  }
  throw new Error("not a cursor this search gave out");
};

/** A short, stable digest for binding a cursor; not a secret, only a check that it is ours. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const claimOf = (row: string): Claim => {
  const s = JSON.parse(row) as Record<string, string | number | undefined>;
  const text = (v: string | number | undefined) => (v === undefined ? undefined : String(v));
  return {
    id: text(s.id) ?? "",
    model: text(s.model_id) ?? "",
    tier: s.tier === "feed" ? "feed" : "record",
    name: text(s.name) ?? "",
    ...(s.english ? { english: text(s.english) } : {}),
    value: text(s.value) ?? "",
    ...(s.unit ? { unit: text(s.unit) } : {}),
    ...(s.conditions ? { conditions: text(s.conditions) } : {}),
    source: text(s.source_id) ?? "",
    ...(typeof s.page === "number" ? { page: s.page } : {}),
    confidence: (text(s.confidence) ?? "unverified") as Claim["confidence"],
    ...(s.extracted_by ? { extractedBy: text(s.extracted_by) } : {}),
    ...(s.reviewed_by ? { reviewedBy: text(s.reviewed_by) } : {}),
    ...(s.doubt ? { doubt: text(s.doubt) } : {}),
  };
};

async function dialectsOf(
  db: Store,
  release: string,
  ids: readonly string[],
): Promise<Map<string, DialectSummary>> {
  const out = new Map<string, DialectSummary>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  const rows = (
    await db
      .prepare(`SELECT id, row FROM dialects WHERE release = ? AND id IN (${marks})`)
      .bind(release, ...ids)
      .all<{ id: string; row: string }>()
  ).results;
  const kinds = (
    await db
      .prepare(
        `SELECT dialect_id, direction, kind FROM dialect_kinds WHERE release = ? AND dialect_id IN (${marks}) ORDER BY CAST(position AS INTEGER)`,
      )
      .bind(release, ...ids)
      .all<{ dialect_id: string; direction: string; kind: string }>()
  ).results;
  const gotchas = (
    await db
      .prepare(
        `SELECT dialect_id, text FROM dialect_gotchas WHERE release = ? AND dialect_id IN (${marks}) ORDER BY CAST(position AS INTEGER)`,
      )
      .bind(release, ...ids)
      .all<{ dialect_id: string; text: string }>()
  ).results;
  const cited = (
    await db
      .prepare(
        `SELECT dialect_id, source_id, citation FROM dialect_sources WHERE release = ? AND dialect_id IN (${marks}) ORDER BY CAST(position AS INTEGER)`,
      )
      .bind(release, ...ids)
      .all<{ dialect_id: string; source_id: string; citation: string }>()
  ).results;
  for (const { id, row } of rows) {
    const d = JSON.parse(row) as Record<string, string | undefined>;
    out.set(id, {
      id,
      family: d.family ?? "",
      ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
      confidence: (d.confidence ?? "unverified") as DialectSummary["confidence"],
      refuter: d.refuter ?? "",
      ...(d.transport ? { transport: d.transport } : {}),
      ...(d.blocks ? { blocks: d.blocks } : {}),
      reports: kinds
        .filter((k) => k.dialect_id === id && k.direction === "reports")
        .map((k) => k.kind),
      accepts: kinds
        .filter((k) => k.dialect_id === id && k.direction === "accepts")
        .map((k) => k.kind),
      gotchas: gotchas.filter((g) => g.dialect_id === id).map((g) => g.text),
      sources: cited
        .filter((c) => c.dialect_id === id)
        .map((c) => ({ source: c.source_id, citation: c.citation })),
    });
  }
  return out;
}

const sourceOf = (row: string): Source => {
  const s = JSON.parse(row) as Record<string, string | boolean | undefined>;
  const text = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  return {
    id: text(s.id) ?? "",
    ...(s.url ? { url: text(s.url) } : {}),
    ...(s.path ? { path: text(s.path) } : {}),
    ...(s.title ? { title: text(s.title) } : {}),
    ...(s.publisher ? { publisher: text(s.publisher) } : {}),
    ...(s.revision ? { revision: text(s.revision) } : {}),
    ...(s.sha256 ? { sha256: text(s.sha256) } : {}),
    ...(s.retrieved_at ? { retrievedAt: text(s.retrieved_at) } : {}),
    ...(typeof s.redistributable === "boolean" ? { redistributable: s.redistributable } : {}),
  };
};

/** Sources by id, in the order asked, those the release holds. More than `LIMITS.sources` is refused, never cut. */
export async function sourcesById(
  db: Store,
  release: string,
  ids: readonly string[],
): Promise<Source[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length > LIMITS.sources)
    throw new RangeError(`at most ${LIMITS.sources} sources a call; ${wanted.length} asked for`);
  if (wanted.length === 0) return [];
  const rows = await inChunks<{ id: string; row: string }>(
    db,
    release,
    wanted,
    (marks) => `SELECT id, row FROM sources WHERE release = ? AND id IN (${marks})`,
  );
  const byId = new Map(rows.map((r) => [r.id, sourceOf(r.row)]));
  return wanted.flatMap((id) => {
    const s = byId.get(id);
    return s ? [s] : [];
  });
}

/** Up to eight models with their claims, their protocol links and exactly the sources those cite. */
export async function bundle(db: Store, release: string, q: BundleQuery): Promise<Bundle> {
  const wanted = [...new Set(q.models)];
  const models = await modelsById(db, release, wanted);
  const held = new Set(models.map((m) => m.id));
  const unknown = wanted.filter((id) => !held.has(id));
  const truncated: Bundle["truncated"] = [];
  const ids = models.map((m) => m.id);
  const marks = ids.map(() => "?").join(", ");

  let claims: Claim[] = [];
  if (q.claims !== false && ids.length > 0) {
    const rows = (
      await db
        .prepare(
          `SELECT row FROM specs WHERE release = ? AND model_id IN (${marks}) ORDER BY model_id, id LIMIT ?`,
        )
        .bind(release, ...ids, LIMITS.bundleClaims + 1)
        .all<{ row: string }>()
    ).results;
    if (rows.length > LIMITS.bundleClaims) truncated.push("claims");
    claims = rows.slice(0, LIMITS.bundleClaims).map((r) => claimOf(r.row));
  }

  let protocol: Bundle["protocol"] = [];
  if (q.protocol !== false && ids.length > 0) {
    const links = (
      await db
        .prepare(
          `SELECT model_id, dialect_id, row FROM model_dialects WHERE release = ? AND model_id IN (${marks}) ORDER BY model_id, dialect_id LIMIT ?`,
        )
        .bind(release, ...ids, LIMITS.bundleProtocol + 1)
        .all<{ model_id: string; dialect_id: string; row: string }>()
    ).results;
    if (links.length > LIMITS.bundleProtocol) truncated.push("protocol");
    const kept = links.slice(0, LIMITS.bundleProtocol);
    const dialects = await dialectsOf(db, release, [...new Set(kept.map((l) => l.dialect_id))]);
    protocol = kept.flatMap((l) => {
      const dialect = dialects.get(l.dialect_id);
      if (!dialect) return [];
      const link = JSON.parse(l.row) as Record<string, string | undefined>;
      return [
        {
          model: l.model_id,
          dialect,
          ...(link.evidence_kind
            ? {
                evidence: {
                  kind: link.evidence_kind,
                  sources: (link.evidence_sources ?? "")
                    .split(" ")
                    .filter(Boolean)
                    .map((source) => ({ source, citation: link.evidence_citation ?? "" })),
                },
              }
            : {}),
          ...(link.confidence
            ? { confidence: link.confidence as DialectSummary["confidence"] }
            : {}),
        },
      ];
    });
  }

  const citedIds = [
    ...new Set([
      ...claims.map((c) => c.source),
      ...protocol.flatMap((p) => [
        ...p.dialect.sources.map((s) => s.source),
        ...(p.evidence?.sources.map((s) => s.source) ?? []),
      ]),
    ]),
  ];
  if (citedIds.length > LIMITS.sources) truncated.push("sources");
  const sources = await sourcesById(db, release, citedIds.slice(0, LIMITS.sources));

  // No property registry yet (#82): every property asked for is a gap that says so.
  const gaps: Gap[] = (q.properties ?? []).flatMap((key) =>
    ids.map((model) => ({ model, key, reason: "no-registry" as const })),
  );
  return { release, models, unknown, properties: [], gaps, claims, protocol, sources, truncated };
}

/** The property registry, empty until #82 defines it. */
export function properties(): PropertyDefinition[] {
  return [];
}

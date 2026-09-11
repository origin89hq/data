import {
  type Bundle,
  type BundleQuery,
  type Claim,
  CONTRACT,
  type DialectCode,
  type DialectReading,
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
import { LINK_CITATIONS } from "@origin89/equipment-schema/model";
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
/** Pairs of (model, dialect) one query may name: two parameters each, under the same ceiling. */
const PAIRS_PER_QUERY = 45;
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

const ids = (rows: { model_id: string }[]): string[] => rows.map((r) => r.model_id);

/**
 * One model, several, or none. With a brand or maker the key must match whole; without, the
 * name's part is matched under every maker. A label is tried as a whole key and then as a name
 * printed after its maker. Near neighbours share the start of the name and are for showing.
 */
/** Keys joined to their models, so a kind can narrow the match in SQL before any cap. */
const KEYED =
  "SELECT k.model_id FROM model_keys k JOIN models m ON m.release = k.release AND m.id = k.model_id WHERE k.release = ?";
const OF_KIND = "AND (? IS NULL OR m.kind = ?)";
/**
 * One row a model, in the order their keys were made, and only as many as it takes to know the
 * match is too wide to count: the read is bounded in SQL, not after it.
 */
const ONE_A_MODEL = "GROUP BY k.model_id ORDER BY MIN(k.rowid) LIMIT ?";
/** The maker's or brand's part of a key: what is left before the name's part. */
const MAKER = "substr(k.key, 1, length(k.key) - length(k.name_key))";
/**
 * The part of a label around the name has to be its maker, or the start of it, or start with
 * it: `Victron SmartSolar MPPT 150/35` reaches the Victron Energy model, and so does the label
 * with a product line in between, but `Renogy SmartSolar MPPT 150/35` reaches nothing, however
 * unique the name is, rather than handing a consumer the wrong maker's claims as `exact`.
 */
const AROUND_NAME = (rest: string) =>
  `(instr(${rest}, ${MAKER}) = 1 OR instr(${MAKER}, ${rest}) = 1)`;
const NAME_LAST = `(substr(?, -length(k.name_key)) = k.name_key AND ${AROUND_NAME("substr(?, 1, length(?) - length(k.name_key))")})`;
const NAME_FIRST = `(substr(?, 1, length(k.name_key)) = k.name_key AND ${AROUND_NAME("substr(?, length(k.name_key) + 1)")})`;
/** The whole label, then the name at the end or at the start: every `?` above is the label. */
const LABEL = `(k.key = ? OR (length(k.name_key) >= 3 AND (${NAME_LAST} OR ${NAME_FIRST})))`;
const LABEL_TIMES = LABEL.split("?").length - 1;

export async function resolve(db: Store, release: string, q: ResolveQuery): Promise<Resolution> {
  const kind = "kind" in q ? q.kind : undefined;
  let found: string[];
  let stem: string;
  const bound = [kind ?? null, kind ?? null, RESOLVE_READ + 1];
  if ("label" in q) {
    const key = keyPart(q.label);
    stem = key;
    found = ids(
      (
        await db
          .prepare(
            // The whole label as a key, or a name printed after its maker, or before it.
            `${KEYED} AND ${LABEL} ${OF_KIND} ${ONE_A_MODEL}`,
          )
          .bind(release, ...Array.from({ length: LABEL_TIMES }, () => key), ...bound)
          .all<{ model_id: string }>()
      ).results,
    );
  } else if (q.brand) {
    stem = nameKey(q.brand, q.model);
    found = ids(
      (
        await db
          .prepare(`${KEYED} AND k.key = ? ${OF_KIND} ${ONE_A_MODEL}`)
          .bind(release, modelKey(q.brand, q.model), ...bound)
          .all<{ model_id: string }>()
      ).results,
    );
  } else {
    stem = keyPart(q.model);
    found = ids(
      (
        await db
          .prepare(`${KEYED} AND k.name_key = ? ${OF_KIND} ${ONE_A_MODEL}`)
          .bind(release, stem, ...bound)
          .all<{ model_id: string }>()
      ).results,
    );
  }
  // The kind narrows before anything is counted, so a kind that singles one model out of many
  // gives `exact`, and a candidate list is cut only after it has been narrowed.
  const overflow = found.length > RESOLVE_READ;
  const models = await modelsById(db, release, found.slice(0, RESOLVE_READ));
  if (models.length === 1 && !overflow) {
    const only = models[0];
    if (only) return { outcome: "exact", model: only };
  }
  if (models.length > 1 || (models.length === 1 && overflow))
    return {
      outcome: "ambiguous",
      candidates: models.slice(0, LIMITS.candidates),
      truncated: overflow || models.length > LIMITS.candidates,
    };
  // Nothing whole. Neighbours by the first characters of the name, for a person to look at.
  const head = stem.slice(0, Math.max(3, Math.min(6, stem.length)));
  // One row a model however many names reach it, and the kind applied in SQL before the cut,
  // so the count is of models a person could pick from and `truncated` means what it says.
  const near =
    head.length < 3
      ? []
      : ids(
          (
            await db
              .prepare(
                `SELECT k.model_id, MIN(k.name_key) AS first FROM model_keys k JOIN models m ON m.release = k.release AND m.id = k.model_id WHERE k.release = ? AND k.name_key LIKE ? ${ESCAPE} ${OF_KIND} GROUP BY k.model_id ORDER BY first, k.model_id LIMIT ?`,
              )
              .bind(release, likePrefix(head), ...bound)
              .all<{ model_id: string }>()
          ).results,
        );
  const shown = await modelsById(db, release, near.slice(0, LIMITS.candidates));
  return {
    outcome: "none",
    near: shown,
    truncated: near.length > LIMITS.candidates,
  };
}

/**
 * How many maker ids, and how many printed names, a brand may answer to in one search: each
 * list is bound into the page's statement beside the release, the prefix, the kind and the
 * cursor's boundary, and D1 binds at most 100 parameters. More is refused with the reason,
 * never cut to a page that looks complete.
 */
const MAKERS_PER_QUERY = 45;

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
  if (ids.size > MAKERS_PER_QUERY || names.length > MAKERS_PER_QUERY)
    throw new RangeError(
      `more than ${MAKERS_PER_QUERY} makers answer to "${brand}"; a search cannot page over them all`,
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
  const scope = scopeOf(release, q);
  const after = q.cursor ? await boundary(db, release, q.cursor, scope) : undefined;
  // A prefix of nothing but the characters a key drops would match every model.
  const prefix = q.prefix === undefined ? undefined : keyPart(q.prefix);
  if (prefix === "") throw new RangeError("the prefix has no letters or digits to match");
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
  if (prefix) {
    where.push(
      `id IN (SELECT model_id FROM model_keys WHERE release = ? AND name_key LIKE ? ${ESCAPE})`,
    );
    params.push(release, likePrefix(prefix));
  }
  if (q.kind) {
    where.push("kind = ?");
    params.push(q.kind);
  }
  if (after) {
    where.push("(name > ? OR (name = ? AND id > ?))");
    params.push(after.name, after.name, after.id);
  }
  const rows = (
    await db
      .prepare(
        `SELECT rowid AS row_id, id, name FROM models WHERE ${where.join(" AND ")} ORDER BY name, id LIMIT ?`,
      )
      .bind(...params, q.limit + 1)
      .all<{ row_id: number; id: string; name: string }>()
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
    ...(truncated && last ? { cursor: joinCursor(last.row_id, last.id, scope) } : {}),
    truncated,
  };
}

/**
 * A cursor names the last row of a page by its place in the store, bound to the release and
 * the query it was given out for. The boundary is read back from the release, so a cursor
 * copied from another search, another release, or made up by hand is refused rather than
 * skipping rows quietly, and a cursor is a short, fixed shape however long a name is.
 */
type Scope = [release: string, brand: string | null, prefix: string | null, kind: string | null];
const scopeOf = (release: string, q: SearchQuery): Scope => [
  release,
  q.brand ?? null,
  q.prefix ?? null,
  q.kind ?? null,
];
/** The digest covers the boundary's place and its id as well as the scope, as one JSON tuple, so no value can run into the next. */
const stamp = (scope: Scope, place: number, id: string): string =>
  fnv1a(JSON.stringify([...scope, place, id]));
const joinCursor = (place: number, id: string, scope: Scope): string =>
  JSON.stringify([place, stamp(scope, place, id)]);
/**
 * The row a cursor points at, read from the release: a made-up cursor can name nothing but a
 * row the release holds, under this very scope, and the page after it is what the release has.
 */
async function boundary(
  db: Store,
  release: string,
  cursor: string,
  scope: Scope,
): Promise<{ name: string; id: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  if (
    Array.isArray(parsed) &&
    typeof parsed[0] === "number" &&
    Number.isInteger(parsed[0]) &&
    typeof parsed[1] === "string"
  ) {
    const row = await db
      .prepare("SELECT id, name FROM models WHERE release = ? AND rowid = ?")
      .bind(release, parsed[0])
      .first<{ id: string; name: string }>();
    if (row && parsed[1] === stamp(scope, parsed[0], row.id)) return row;
  }
  throw new Error("not a cursor this search gave out");
}

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
  const readings = (
    await db
      .prepare(
        `SELECT dialect_id, row FROM dialect_readings WHERE release = ? AND dialect_id IN (${marks}) ORDER BY position`,
      )
      .bind(release, ...ids)
      .all<{ dialect_id: string; row: string }>()
  ).results;
  const codes = (
    await db
      .prepare(
        `SELECT dialect_id, row FROM dialect_codes WHERE release = ? AND dialect_id IN (${marks}) ORDER BY position`,
      )
      .bind(release, ...ids)
      .all<{ dialect_id: string; row: string }>()
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
      readings: readings.filter((r) => r.dialect_id === id).map((r) => readingOf(r.row)),
      codes: codes.filter((c) => c.dialect_id === id).map((c) => codeOf(c.row)),
    });
  }
  return out;
}

const readingOf = (row: string): DialectReading => {
  const r = JSON.parse(row) as Record<string, string | number | boolean | undefined>;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    metric: text(r.metric) ?? "",
    at: text(r.at) ?? "",
    ...(r.unit ? { unit: text(r.unit) } : {}),
    ...(r.scale !== undefined ? { scale: Number(r.scale) } : {}),
    ...(r.signed === true ? { signed: true } : {}),
    ...(typeof r.words === "number" ? { words: r.words } : {}),
    ...(r.word_order === "low-first" || r.word_order === "high-first"
      ? { order: r.word_order }
      : {}),
    ...(r.sentinel ? { sentinel: text(r.sentinel) } : {}),
    origin: (text(r.origin) ?? "reported") as DialectReading["origin"],
    source: text(r.source_id) ?? "",
    ...(r.citation ? { citation: text(r.citation) } : {}),
    ...(typeof r.page === "number" ? { page: r.page } : {}),
  };
};

const codeOf = (row: string): DialectCode => {
  const c = JSON.parse(row) as Record<string, string | number | undefined>;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    table: (text(c.code_table) ?? "state") as DialectCode["table"],
    ...(c.at ? { at: text(c.at) } : {}),
    code: text(c.code) ?? "",
    meaning: text(c.meaning) ?? "",
    source: text(c.source_id) ?? "",
    ...(c.citation ? { citation: text(c.citation) } : {}),
    ...(typeof c.page === "number" ? { page: c.page } : {}),
  };
};

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
    // What says each model speaks its dialect (#84), beside the dialect's own citations.
    // Citations of the links kept, and no other: a model with more links than the bound is read
    // for the bound's worth, pair by pair, under D1's parameter ceiling.
    const cited: { model_id: string; dialect_id: string; source_id: string; citation: string }[] =
      [];
    for (let at = 0; at < kept.length; at += PAIRS_PER_QUERY) {
      const pairs = kept.slice(at, at + PAIRS_PER_QUERY);
      const clause = pairs.map(() => "(model_id = ? AND dialect_id = ?)").join(" OR ");
      cited.push(
        ...(
          await db
            .prepare(
              `SELECT model_id, dialect_id, source_id, citation FROM model_dialect_sources WHERE release = ? AND (${clause}) ORDER BY model_id, dialect_id, position LIMIT ?`,
            )
            .bind(
              release,
              ...pairs.flatMap((l) => [l.model_id, l.dialect_id]),
              pairs.length * LINK_CITATIONS + 1,
            )
            .all<{ model_id: string; dialect_id: string; source_id: string; citation: string }>()
        ).results,
      );
    }
    // The schema admits at most `LINK_CITATIONS` a link, so the read is bounded by the links
    // kept; a store that holds more for any one link is not a release the schema admits, and
    // says so rather than answering with some of that link's citations. The rows come ordered
    // by pair, so a link past the bound is seen whole or cut at the limit, and counted either way.
    const perLink = new Map<string, number>();
    for (const c of cited) {
      const key = `${c.model_id}\u0000${c.dialect_id}`;
      const n = (perLink.get(key) ?? 0) + 1;
      perLink.set(key, n);
      if (n > LINK_CITATIONS)
        throw new RangeError(
          `the link ${c.model_id} → ${c.dialect_id} cites more than ${LINK_CITATIONS} sources; the release is not one the schema admits`,
        );
    }
    protocol = kept.flatMap((l) => {
      const dialect = dialects.get(l.dialect_id);
      if (!dialect) return [];
      const link = JSON.parse(l.row) as Record<string, string | undefined>;
      const sources = cited
        .filter((c) => c.model_id === l.model_id && c.dialect_id === l.dialect_id)
        .map((c) => ({ source: c.source_id, citation: c.citation }));
      return [
        {
          model: l.model_id,
          dialect,
          ...(link.evidence_kind ? { evidence: { kind: link.evidence_kind, sources } } : {}),
          ...(link.confidence
            ? { confidence: link.confidence as DialectSummary["confidence"] }
            : {}),
          ...(link.firmware_min || link.firmware_max
            ? {
                firmware: {
                  ...(link.firmware_min ? { min: link.firmware_min } : {}),
                  ...(link.firmware_max ? { max: link.firmware_max } : {}),
                },
              }
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
        ...p.dialect.readings.map((r) => r.source),
        ...p.dialect.codes.map((c) => c.source),
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

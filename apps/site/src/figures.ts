/**
 * A model's rated figures as the record detail lists them, each with the document it was read
 * from. Two rows that look alike are usually one figure printed by two documents, the datasheet
 * and the manual, under slightly different names; naming the document beside the page is what
 * lets a reader tell two sources agreeing from a duplicate.
 */

/** The figures of one model, with the title, address, archive path and id of the document each cites. */
export const figuresQuery = (
  model: string,
): string => `SELECT coalesce(s.english, s.name) AS figure, s.value, s.unit, s.page, s.doubt,
    src.title AS document, src.url AS document_url, src.path AS document_path,
    src.id AS document_id
    FROM specs s LEFT JOIN sources src ON src.id = s.source_id
    WHERE s.model_id = '${model.replaceAll("'", "''")}' AND s.tier <> 'feed'
    ORDER BY CASE WHEN s.doubt IS NULL THEN 0 ELSE 1 END, figure, document, document_url LIMIT 60`;

export interface FigureRow {
  figure?: unknown;
  value?: unknown;
  unit?: unknown;
  page?: unknown;
  doubt?: unknown;
  document?: unknown;
  document_url?: unknown;
  /** Where the archive filed the document, for one cited only there. */
  document_path?: unknown;
  document_id?: unknown;
}

type DocumentRow = Pick<FigureRow, "document" | "document_url" | "document_path" | "document_id">;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** What locates the document: its address, else its archive path. */
const locator = (row: DocumentRow): string | undefined =>
  text(row.document_url) ?? text(row.document_path);

/** What tells one document from another among a model's figures. */
const documentKey = (row: DocumentRow): string | undefined => text(row.document_id) ?? locator(row);

const EXTENSION = /\.(pdf|html?|php|aspx?)$/i;

/**
 * The document a figure comes from, as a person would name it: its title when the record has
 * one, else the file's own name off its address or its archive path, else the site, else the
 * source's id. No source record carries a title yet, and one site publishes many files, so the
 * file name is what tells the GS4048A brochure from its operator manual; a document the archive
 * holds without an address still has a file name there.
 */
export function documentLabel(row: DocumentRow): string | undefined {
  const title = text(row.document);
  if (title) return title;
  const where = locator(row);
  if (where) {
    const file = segments(where).at(-1);
    if (file) return file.replace(EXTENSION, "");
    try {
      return new URL(where).hostname.replace(/^www\./, "");
    } catch {
      return where;
    }
  }
  return text(row.document_id);
}

/** The segments of an address's path, or of a plain path, decoded, without the empty ones. */
function segments(where: string): string[] {
  let path = where;
  try {
    path = new URL(where).pathname;
  } catch {
    // Not an address: an archive path, read as it is.
  }
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/**
 * One label per document among a model's figures, by address. A maker publishes the same file
 * name under two directories, `MultiPlus-II_GX/` and `MultiPlus-II_4k5_6k5_GX/`, for two
 * documents; where two addresses come out with one name, the directory above the file is put in
 * front, and the whole path when that is still not enough.
 */
export function documentLabels(rows: readonly DocumentRow[]): Map<string, string> {
  const labels = new Map<string, string>();
  const located = new Map<string, string>();
  for (const row of rows) {
    const key = documentKey(row);
    if (!key || labels.has(key)) continue;
    const label = documentLabel(row);
    if (label) labels.set(key, label);
    const where = locator(row);
    if (where) located.set(key, where);
  }
  for (const depth of [2, Number.POSITIVE_INFINITY]) {
    const byLabel = new Map<string, string[]>();
    for (const [key, label] of labels) byLabel.set(label, [...(byLabel.get(label) ?? []), key]);
    for (const keys of byLabel.values()) {
      if (keys.length < 2) continue;
      for (const key of keys) {
        const where = located.get(key);
        const parts = where ? segments(where) : [];
        if (parts.length < 2) continue;
        const shown = parts.slice(-Math.min(depth, parts.length));
        const last = shown.length - 1;
        shown[last] = (shown[last] ?? "").replace(EXTENSION, "");
        labels.set(key, shown.join("/"));
      }
    }
  }
  return labels;
}

/**
 * "Datasheet · page 3", "Datasheet", "page 3", or nothing: the document and the page, whichever
 * the row has. `labels`, from [`documentLabels`], names the document apart from the model's others.
 */
export function provenanceLabel(
  row: DocumentRow & Pick<FigureRow, "page">,
  labels?: ReadonlyMap<string, string>,
): string | undefined {
  const parts: string[] = [];
  const key = documentKey(row);
  const document = (key ? labels?.get(key) : undefined) ?? documentLabel(row);
  if (document) parts.push(document);
  if (row.page !== null && row.page !== undefined) parts.push(`page ${String(row.page)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

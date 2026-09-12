/**
 * A model's rated figures as the record detail lists them, each with the document it was read
 * from. Two rows that look alike are usually one figure printed by two documents, the datasheet
 * and the manual, under slightly different names; naming the document beside the page is what
 * lets a reader tell two sources agreeing from a duplicate.
 */

/** The figures of one model, with the title and address of the document each cites. */
export const figuresQuery = (
  model: string,
): string => `SELECT coalesce(s.english, s.name) AS figure, s.value, s.unit, s.page, s.doubt,
    src.title AS document, src.url AS document_url
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
}

/**
 * The document a figure comes from, as a person would name it: its title when the record has
 * one, else the file's own name off its address, else the site. No source record carries a title
 * yet, and one site publishes many files, so the file name is what tells the GS4048A brochure
 * from its operator manual.
 */
export function documentLabel(
  row: Pick<FigureRow, "document" | "document_url">,
): string | undefined {
  if (typeof row.document === "string" && row.document.trim()) return row.document.trim();
  if (typeof row.document_url === "string" && row.document_url.trim()) {
    let url: URL;
    try {
      url = new URL(row.document_url);
    } catch {
      return row.document_url.trim();
    }
    const file = url.pathname.split("/").filter(Boolean).at(-1);
    if (file) {
      let name = file;
      try {
        name = decodeURIComponent(file);
      } catch {
        // Not percent-encoded as a whole; the raw segment still names the file.
      }
      return name.replace(/\.(pdf|html?|php|aspx?)$/i, "");
    }
    return url.hostname.replace(/^www\./, "");
  }
  return undefined;
}

/** The path segments of an address, decoded, without the empty ones. */
function segments(url: string): string[] {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return [];
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
export function documentLabels(
  rows: readonly Pick<FigureRow, "document" | "document_url">[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.document_url !== "string" || labels.has(row.document_url)) continue;
    const label = documentLabel(row);
    if (label) labels.set(row.document_url, label);
  }
  for (const depth of [2, Number.POSITIVE_INFINITY]) {
    const byLabel = new Map<string, string[]>();
    for (const [url, label] of labels) byLabel.set(label, [...(byLabel.get(label) ?? []), url]);
    for (const urls of byLabel.values()) {
      if (urls.length < 2) continue;
      for (const url of urls) {
        const parts = segments(url);
        if (parts.length < 2) continue;
        const shown = parts.slice(-Math.min(depth, parts.length));
        const last = shown.length - 1;
        shown[last] = (shown[last] ?? "").replace(/\.(pdf|html?|php|aspx?)$/i, "");
        labels.set(url, shown.join("/"));
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
  row: Pick<FigureRow, "document" | "document_url" | "page">,
  labels?: ReadonlyMap<string, string>,
): string | undefined {
  const parts: string[] = [];
  const document =
    (typeof row.document_url === "string" ? labels?.get(row.document_url) : undefined) ??
    documentLabel(row);
  if (document) parts.push(document);
  if (row.page !== null && row.page !== undefined) parts.push(`page ${String(row.page)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

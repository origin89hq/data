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

/** "Datasheet · page 3", "Datasheet", "page 3", or nothing: the document and the page, whichever the row has. */
export function provenanceLabel(
  row: Pick<FigureRow, "document" | "document_url" | "page">,
): string | undefined {
  const parts: string[] = [];
  const document = documentLabel(row);
  if (document) parts.push(document);
  if (row.page !== null && row.page !== undefined) parts.push(`page ${String(row.page)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

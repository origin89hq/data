/**
 * A page's table, read from where its characters sit.
 *
 * A converter that returns a page as a stream of text loses what a datasheet says with its layout:
 * which model a value belongs to. BSL's 48 V sheet reached the reader as "Additional DataWorking
 * Current" and "Cut-off VoltageChargeVoltage", a row's name fused to the label above it and its
 * values adrift, and the figures read out of it put a weight where a voltage belongs. The
 * characters themselves carry the answer: PDFium says where each one sits, and a value under a
 * model's column is that model's.
 *
 * Nothing here asks a model anything. It is arithmetic over boxes, so a table read this way is the
 * same table every time it is read.
 */

/** One character as PDFium places it, in points from the bottom left of the page. */
export interface Char {
  text: string;
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** A run of characters with no gap wide enough to be a column: one cell of one row. */
export interface Cell {
  text: string;
  left: number;
  right: number;
}

/** The characters that share a line of the page, cut into cells. */
export interface Row {
  top: number;
  bottom: number;
  cells: Cell[];
}

const median = (numbers: readonly number[]): number =>
  [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)] ?? 0;

/**
 * How much of two boxes' heights overlap, as a fraction of the shorter one. Characters of one line
 * overlap almost completely; a superscript overlaps its line enough; the line below does not.
 */
function sharesLine(
  a: { top: number; bottom: number },
  b: { top: number; bottom: number },
): boolean {
  const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
  const shorter = Math.min(a.top - a.bottom, b.top - b.bottom);
  return shorter > 0 && overlap / shorter > 0.4;
}

/**
 * The characters of one line cut into cells: a gap wider than the line's own letters is a column
 * boundary, and a gap narrower than that is a space. Sized from the line rather than from the page,
 * since a heading's spaces are wider than a footnote's letters.
 */
function cellsOf(chars: readonly Char[]): Cell[] {
  // A space's own box is a letter wide, and counting it would make every gap look ordinary.
  const widths = chars
    .filter((c) => c.text.trim())
    .map((c) => c.right - c.left)
    .filter((w) => w > 0);
  const gap = Math.max(median(widths) * 1.2, 3);
  const cells: Cell[] = [];
  for (const char of chars) {
    const open = cells.at(-1);
    if (open && char.left - open.right <= gap) {
      open.text += char.text;
      open.right = Math.max(open.right, char.right);
      continue;
    }
    cells.push({ text: char.text, left: char.left, right: char.right });
  }
  return cells
    .map((cell) => ({ ...cell, text: cell.text.replace(/\s+/g, " ").trim() }))
    .filter((cell) => cell.text);
}

/** A page's characters as rows of cells, top of the page first. */
export function rowsOf(chars: readonly Char[]): Row[] {
  const rows: { top: number; bottom: number; chars: Char[] }[] = [];
  for (const char of [...chars].sort((a, b) => b.top - a.top || a.left - b.left)) {
    // A line break is not on the page; a space is, and it is what holds "42 kg" together.
    if (/[\r\n]/.test(char.text)) continue;
    const row = rows.find((r) => sharesLine(r, char));
    if (row) {
      row.chars.push(char);
      row.top = Math.max(row.top, char.top);
      row.bottom = Math.min(row.bottom, char.bottom);
      continue;
    }
    rows.push({ top: char.top, bottom: char.bottom, chars: [char] });
  }
  return (
    rows
      .map((row) => ({
        top: row.top,
        bottom: row.bottom,
        cells: cellsOf([...row.chars].sort((a, b) => a.left - b.left)),
      }))
      // A line of spaces is where a line ended, not a row of the page.
      .filter((row) => row.cells.length > 0)
  );
}

/** How many rows must start a cell at the same place before that place is a column. */
export const LEAST_ROWS = 3;

/**
 * The columns of a page: the left edges its rows keep coming back to. One row's indent is not a
 * column, which is what keeps a paragraph from being read as a table.
 *
 * Two edges that no row ever uses at once are one column. A datasheet writes "Dimension" and
 * "(L*W*H) ±2mm" as two cells of the name column and a heading spans the page above them; without
 * this the page reads as a dozen columns, most of them empty in most rows.
 */
export function columnsOf(rows: readonly Row[], leastRows = LEAST_ROWS): number[] {
  const widths = rows.flatMap((row) => row.cells.map((c) => c.right - c.left)).filter((w) => w > 0);
  const near = Math.max(median(widths) * 0.5, 2);
  const found: { at: number; rows: Set<number>; used: number }[] = [];
  for (const [index, row] of rows.entries()) {
    for (const cell of row.cells) {
      const last = found.find((f) => Math.abs(f.at - cell.left) < near);
      if (last) {
        last.at = (last.at * last.used + cell.left) / (last.used + 1);
        last.used += 1;
        last.rows.add(index);
        continue;
      }
      found.push({ at: cell.left, rows: new Set([index]), used: 1 });
    }
  }
  const kept = found.filter((column) => column.rows.size >= leastRows).sort((a, b) => a.at - b.at);
  // Columns no row fills at once are one column said twice: the same cell wrapped, or a label and
  // its unit written apart.
  const merged: typeof kept = [];
  for (const column of kept) {
    const last = merged.at(-1);
    const together = last && [...column.rows].some((row) => last.rows.has(row));
    if (last && !together) {
      last.rows = new Set([...last.rows, ...column.rows]);
      continue;
    }
    merged.push({ ...column, rows: new Set(column.rows) });
  }
  return merged.map((column) => column.at);
}

/** Each row's cells put under the column they start at, as text. */
export function gridOf(rows: readonly Row[], columns: readonly number[]): string[][] {
  return rows.map((row) => {
    const line = columns.map(() => "");
    for (const cell of row.cells) {
      let best = 0;
      for (let i = 1; i < columns.length; i += 1) {
        const column = columns[i] ?? 0;
        if (Math.abs(column - cell.left) < Math.abs((columns[best] ?? 0) - cell.left)) best = i;
      }
      line[best] = line[best] ? `${line[best]} ${cell.text}` : cell.text;
    }
    return line;
  });
}

/** A cell as Markdown: a pipe inside one would end the cell it is in. */
const escaped = (text: string): string => text.replace(/\|/g, "\\|");

/**
 * A page as Markdown: its table as a pipe table, and everything before or after it as its own
 * lines. A page with one column is prose and is written as prose — a manual's paragraphs are not a
 * table with one cell a row, and reading them as one would put a pipe through every sentence.
 */
export function markdownOf(chars: readonly Char[]): string {
  const rows = rowsOf(chars);
  const columns = columnsOf(rows);
  if (columns.length < 2)
    return rows.map((row) => row.cells.map((c) => c.text).join(" ")).join("\n");
  const grid = gridOf(rows, columns);
  const lines: string[] = [];
  let table = false;
  for (const line of grid) {
    const filled = line.filter((cell) => cell).length;
    if (filled < 2) {
      // A line that fills one column is a heading or a sentence between tables, not a row of one.
      if (table) lines.push("");
      table = false;
      const text = line.find((cell) => cell);
      if (text) lines.push(text);
      continue;
    }
    if (!table) {
      lines.push(`| ${line.map(() => " ").join("|")}|`);
      lines.push(`|${line.map(() => "---").join("|")}|`);
      table = true;
    }
    lines.push(`| ${line.map((cell) => escaped(cell)).join(" | ")} |`);
  }
  return lines.join("\n");
}

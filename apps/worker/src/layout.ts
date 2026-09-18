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
  /** Which way it faces, in radians, when that is not along the page. */
  angle?: number;
  /** The size it is set in, in points, which is how a heading is told from the text under it. */
  size?: number;
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
  const letter = median(widths);
  const gap = Math.max(letter * 1.2, 3);
  // Some documents set no spaces at all and put their words apart by moving the pen: an EPEVER
  // manual reads "Becarefulwheninstallingthebatteries". Where a line writes its own spaces they are
  // the line's, and nothing is added; where it writes none, a gap wider than its letters is one.
  const spaces = chars.some((c) => /\s/.test(c.text));
  const space = spaces ? Number.POSITIVE_INFINITY : Math.max(letter * 0.6, 0.6);
  const cells: Cell[] = [];
  for (const char of chars) {
    const open = cells.at(-1);
    if (open && char.left - open.right <= gap) {
      const apart = char.left - open.right;
      if (apart > space && !/\s$/.test(open.text) && !/^\s/.test(char.text)) open.text += " ";
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

/** A line a document sets apart as a heading, with the page it stands on. */
export interface Heading {
  page: number;
  text: string;
  /** The size it is set in, so a section's heading can be told from its subheadings. */
  size: number;
}

/**
 * A page's headings: the lines set in a larger face than the page's own text, and the numbered
 * lines a manual titles its sections with ("2.2 Requirements for the PV array") whatever their
 * size. Both stand alone on their line; a table's cells do not.
 *
 * What this is for: a manual states its ratings in a few of its sections, and prints instructions,
 * warranties and troubleshooting in the rest. The outline is what lets those be left unread, and it
 * costs nothing to find.
 */
const NUMBERED = /^\d+(\.\d+)*[.)]?\s+\S/;
export function headingsOn(chars: readonly Char[], page: number): Heading[] {
  const rows = rowsOf(chars);
  const sizes = chars.map((c) => c.size ?? c.top - c.bottom).filter((s) => s > 0);
  const body = median(sizes);
  const headings: Heading[] = [];
  for (const row of rows) {
    // A heading is a line to itself: a row of several cells is a table's row, not a title. A
    // numbered one is two, since a manual sets the number clear of the words: "2" then
    // "Installation", "2.2" then "Requirements for the PV array".
    const numbered =
      row.cells.length === 2 && /^\d+(\.\d+)*[.)]?$/.test(row.cells[0]?.text ?? "")
        ? `${row.cells[0]?.text} ${row.cells[1]?.text}`
        : undefined;
    if (row.cells.length !== 1 && !numbered) continue;
    const text = numbered ?? row.cells[0]?.text ?? "";
    if (!text || text.length > 120) continue;
    const size = row.top - row.bottom;
    if (size > body * 1.15 || NUMBERED.test(text)) headings.push({ page, text, size });
  }
  return headings;
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

/** A quarter turn, to the nearest one: 0 along the page, 1 up the side, 2 upside down, 3 down it. */
function quarterTurn(char: Char): number {
  return ((Math.round((char.angle ?? 0) / (Math.PI / 2)) % 4) + 4) % 4;
}

/**
 * A character placed as though its own direction were along the page, so a label printed sideways
 * is a line of text rather than one letter of every row it stands beside.
 */
function turned(char: Char, turn: number): Char {
  // The angle goes with the turn: placed along the page, the character faces along it, and a
  // second turn would take it off again.
  const { left, right, bottom, top, angle: _placed, ...rest } = char;
  // A quarter turn one way reads down the page, the other reads up it; the line beside it is the
  // next column of the page it was printed on.
  if (turn === 1) return { ...rest, left: -top, right: -bottom, bottom: -right, top: -left };
  if (turn === 2) return { ...rest, left: -right, right: -left, bottom: -top, top: -bottom };
  if (turn === 3) return { ...rest, left: bottom, right: top, bottom: -right, top: -left };
  return { ...rest, left, right, bottom, top };
}

/** A cell as Markdown: a pipe inside one would end the cell it is in. */
const escaped = (text: string): string => text.replace(/\|/g, "\\|");

/**
 * A page as Markdown: its table as a pipe table, and everything before or after it as its own
 * lines. A page with one column is prose and is written as prose — a manual's paragraphs are not a
 * table with one cell a row, and reading them as one would put a pipe through every sentence.
 */
export function markdownOf(chars: readonly Char[]): string {
  const facing = new Map<number, Char[]>();
  for (const char of chars) {
    const turn = quarterTurn(char);
    facing.set(turn, [...(facing.get(turn) ?? []), turned(char, turn)]);
  }
  // Read what faces along the page first, then each direction printed across it, so a page number
  // up the spine is a line after the page rather than a letter in every row it passes.
  if (facing.size > 1) {
    return [...facing.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, side]) => markdownOf(side))
      .filter((part) => part.trim())
      .join("\n\n");
  }
  const rows = rowsOf([...facing.values()][0] ?? []);
  const columns = columnsOf(rows);
  const grid = columns.length < 2 ? [] : gridOf(rows, columns);
  // A page is a table when enough of its lines fill more than one column. A paragraph indented here
  // and there fills a second column on a line or two, and written as a table it is mostly pipes: an
  // EPEVER installation page came out as twelve columns of nothing around its sentences.
  const across = grid.filter((line) => line.filter((cell) => cell).length > 1).length;
  if (columns.length < 2 || across < 3 || across < rows.length * 0.2)
    return rows.map((row) => row.cells.map((c) => c.text).join(" ")).join("\n");
  const lines: string[] = [];
  let table = false;
  for (const line of grid) {
    const filled = line.filter((cell) => cell).length;
    // "2" then "Installation" is a section's heading with its number set clear of it, not a row of
    // two cells. Written as a row it would be a table line in the middle of a manual's prose.
    const numbered =
      filled === 2 && /^\d+(\.\d+)*[.)]?$/.test(line[0] ?? "")
        ? line.filter((c) => c).join(" ")
        : undefined;
    if (numbered) {
      if (table) lines.push("");
      table = false;
      lines.push(numbered);
      continue;
    }
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

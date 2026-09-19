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

/** A line drawn down a page: where it stands, and the height it runs between, in points. */
export interface Rule {
  x: number;
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
  /** The size its characters are set in, for telling a heading from the text around it. */
  size: number;
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
  const cells: (Cell & { chars: Char[] })[] = [];
  for (const char of chars) {
    const open = cells.at(-1);
    if (open && char.left - open.right <= gap) {
      open.text += char.text;
      open.chars.push(char);
      open.right = Math.max(open.right, char.right);
      continue;
    }
    cells.push({ text: char.text, left: char.left, right: char.right, chars: [char] });
  }
  return cells
    .map(({ chars: run, ...cell }) => ({ ...cell, text: spaced(run, cell.text).trim() }))
    .filter((cell) => cell.text);
}

/**
 * The words of one cell. Some documents set no spaces at all and put their words apart by moving
 * the pen: an EPEVER manual reads "Becarefulwheninstallingthebatteries", and its section titles
 * read "Requirementsforthe PVarray". Where a run of text writes its own spaces they are its own and
 * nothing is added; where it writes none, a gap much wider than the ones between its letters is a
 * space.
 */
function spaced(run: readonly Char[], text: string): string {
  if (/\s/.test(text) || run.length < 3) return text.replace(/\s+/g, " ");
  const between: number[] = [];
  for (let i = 1; i < run.length; i += 1) {
    const apart = (run[i]?.left ?? 0) - (run[i - 1]?.right ?? 0);
    if (apart > 0) between.push(apart);
  }
  if (between.length === 0) return text;
  const widths = run.map((c) => c.right - c.left).filter((w) => w > 0);
  const space = Math.max(median(between) * 2.5, median(widths) * 0.45);
  let out = run[0]?.text ?? "";
  for (let i = 1; i < run.length; i += 1) {
    const apart = (run[i]?.left ?? 0) - (run[i - 1]?.right ?? 0);
    out += (apart > space ? " " : "") + (run[i]?.text ?? "");
  }
  return out;
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
        // The font's own size where the document gives it, since a glyph box is only as tall as the
        // letters in it: a line with no descender is shorter than the same line with one.
        size: median(row.chars.map((c) => c.size ?? c.top - c.bottom).filter((n) => n > 0)),
        cells: cellsOf([...row.chars].sort((a, b) => a.left - b.left)),
      }))
      // A line of spaces is where a line ended, not a row of the page.
      .filter((row) => row.cells.length > 0)
  );
}

/** A stretch of a document under one heading: what it is called, and the pages it runs over. */
export interface Section {
  title: string;
  from: number;
  to: number;
  /** How the section opens, so what it holds can be judged by more than its name. */
  opening?: string;
}

/** How much of a section is shown to say what it holds: a line or two, not the section. */
export const OPENING = 240;

/**
 * Each section with the words it opens with, read out of the document's own markdown.
 *
 * A title is often not enough to say whether a section states ratings. "Requirements for the PV
 * array" says nothing either way until its first lines say "the below table is for reference only";
 * "Wire size and circuit breaker" reads like an installer's section until its table turns out to
 * state each model's rated current; and an appendix headed "Solar Module MPP Voltage (17V, 34V)"
 * reads like a specification until the line under it gives the test conditions of a curve.
 */
export function withOpenings(markdown: string, sections: readonly Section[]): Section[] {
  const lines = markdown.split("\n");
  // Which page each line stands on, so a section is read within its own pages: a heading repeated
  // in a table of contents would otherwise stand in for the section itself, and a short section
  // would open with the one after it.
  const pages: number[] = [];
  let page = 0;
  for (const line of lines) {
    const marked = /^### Page (\d+)$/.exec(line);
    if (marked) page = Number(marked[1]);
    pages.push(page);
  }
  // A heading is matched by its letters: the outline reads a page's own characters and the markdown
  // is written from cells, and the two space a title differently — "MPPVoltage" against "MPP
  // Voltage" — which as an exact match found a heading in one section of eight.
  const same = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const folded = lines.map(same);
  return sections.map((section) => {
    const within = (index: number): boolean =>
      (pages[index] ?? 0) >= section.from && (pages[index] ?? 0) <= section.to;
    const at = section.title
      ? folded.findIndex((line, index) => line === same(section.title) && within(index))
      : 0;
    if (at < 0) return section;
    const ends = lines.findIndex((_, index) => index > at && !within(index));
    const after = lines
      .slice(at + 1, ends < 0 ? undefined : ends)
      .filter((line) => line.trim() && !/^\|[\s|:-]*\|$/.test(line) && !/^### Page \d+$/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const opening = after.slice(0, OPENING).trim();
    return opening ? { ...section, opening } : section;
  });
}

/**
 * A document's sections, from its headings: each runs from its own page to the page before the next
 * heading no deeper than itself. "2 Installation" ends where "3 Working" begins, and "2.2
 * Requirements for the PV array" ends within it.
 *
 * What runs before the first heading is a section of its own, since a datasheet states its figures
 * on page one under no heading at all, and a document with no headings is one section: the whole of
 * it. Neither may be lost by asking which sections to read.
 */
export function sectionsOf(outline: readonly Heading[], pages: number): Section[] {
  const depth = (heading: Heading): number => {
    const numbered = /^(\d+(?:\.\d+)*)/.exec(heading.text);
    return numbered ? (numbered[1]?.split(".").length ?? 1) : 0;
  };
  const sections: Section[] = [];
  const first = outline[0];
  if (!first || first.page > 1)
    sections.push({ title: "", from: 1, to: (first?.page ?? pages + 1) - 1 });
  for (const [index, heading] of outline.entries()) {
    const mine = depth(heading);
    const next = outline
      .slice(index + 1)
      .find((later) => depth(later) <= mine && later.page > heading.page);
    sections.push({
      title: heading.text,
      from: heading.page,
      to: next ? Math.max(heading.page, next.page - 1) : pages,
    });
  }
  return sections;
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
/**
 * A numbered heading: a section number and words after it. The words matter — "12 V" is a figure,
 * not a section, and read as one it cut a document into sections at every voltage it printed.
 */
const NUMBERED = /^\d+(\.\d+)*[.)]?\s+.*[A-Za-z]{3,}/;
export function headingsOn(chars: readonly Char[], page: number): Heading[] {
  const rows = rowsOf(chars);
  // A heading is set larger than the page's own text, both measured the same way: by the size each
  // row is set in. Measuring one by the font and the other by its glyph boxes compared one number
  // with a different one, and a heading set larger could read as body text.
  const body = median(rows.map((row) => row.size).filter((size) => size > 0));
  const headings: Heading[] = [];
  for (const row of rows) {
    // A heading is a line to itself: a row of several cells is a table's row, not a title. A
    // numbered one is two, since a manual sets the number clear of the words: "2" then
    // "Installation", "2.2" then "Requirements for the PV array".
    const pair =
      row.cells.length === 2 && /^\d+(\.\d+)*[.)]?$/.test(row.cells[0]?.text ?? "")
        ? `${row.cells[0]?.text} ${row.cells[1]?.text}`
        : undefined;
    const numbered = pair && NUMBERED.test(pair) ? pair : undefined;
    if (row.cells.length !== 1 && !numbered) continue;
    const text = numbered ?? row.cells[0]?.text ?? "";
    if (!text || text.length > 120) continue;
    if (row.size > body * 1.15 || NUMBERED.test(text))
      headings.push({ page, text, size: row.size });
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

/**
 * A column a page's rules give: its left edge, and the heights it divides — the tables with a rule
 * at that edge, each from the lowest piece of its rules to the highest, gaps and all. A rule stops
 * where a cell is drawn across it, and that cell is still in the table. Two tables on a page can
 * rule a column at the same edge; the page between them is in neither.
 */
export interface RuledColumn {
  at: number;
  spans: { bottom: number; top: number }[];
}

/**
 * Each row's cells put under the column they start at, as text.
 *
 * Where the columns are a page's rules, a cell belongs to every column its text stands in, but only
 * across a rule that runs past its row. EPEVER merges XTRA1206N and XTRA2206N into one cell for the
 * figures they share, and under one of them alone the other model took the value of the model after
 * it. A line of text above the table crosses nothing of the table's, and split at every upright
 * line on its page, one sentence of Victron's booklet was written into 14 columns. And a cell
 * across every rule of its row's table is a note or a caption across it, said once, not a value of
 * each of its columns; the page's other tables have rules of their own, at other edges.
 */
export function gridOf(
  rows: readonly Row[],
  columns: readonly number[],
  ruled?: readonly RuledColumn[],
): string[][] {
  return rows.map((row) => {
    const line = columns.map(() => "");
    const middle = (row.top + row.bottom) / 2;
    const runsPast = (i: number): boolean =>
      !ruled?.[i] ||
      (ruled[i]?.spans.some((span) => middle >= span.bottom - PAST && middle <= span.top + PAST) ??
        false);
    // The rules of this row's table: where a new column opens on this row.
    const active = ruled ? columns.map((_, i) => i).filter((i) => i > 0 && runsPast(i)) : [];
    for (const cell of row.cells) {
      const across = ruled
        ? columns
            .map((from, i) => ({ i, to: columns[i + 1] ?? Number.POSITIVE_INFINITY, from }))
            .filter(
              ({ from, to }) => Math.min(cell.right, to) - Math.max(cell.left, from) > CROSSES,
            )
            .map(({ i }) => i)
        : [];
      if (across.length > 0) {
        // A new column only where the rule opening it runs past this row; else still the last one.
        const split = across.filter((i, k) => k === 0 || runsPast(i));
        const into = split.length - 1 === active.length ? split.slice(0, 1) : split;
        for (const i of into) line[i] = line[i] ? `${line[i]} ${cell.text}` : cell.text;
        continue;
      }
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

/** How far into a column a cell must stand to be in it, so a hair over a rule is not two cells. */
const CROSSES = 1.5;

/** How far past a rule's end a row may stand and still be beside it, in points. */
const PAST = 2;

/**
 * How much taller than a line of text one piece of a rule must be to be a table's. A table's rule
 * runs the height of a row at least, the text in it and the space above and below; a letter drawn
 * as a shape has upright strokes no taller than itself. On Victron's page the strokes are 5 and 6
 * points beside lines of 7 and 8. OutBack's FLEXmax settings rule their 24, 36 and 48 volt columns
 * only on the rows that set a value for each, a piece a row tall: 10 to 13 points beside lines of 7.
 */
const RULE_LINE = 1.3;

/** How many rows beside a rule must start a cell in the column it opens for it to be a table's. */
const HOLDS = 2;

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
/**
 * The columns a page's own rules give: what stands left of the first rule is a column, and each
 * rule opens another. Two rules a hair apart are one line drawn twice.
 *
 * A rule is a table's only if one piece of it is taller than a line of text (`RULE_LINE`); what is
 * drawn upright and shorter is the stroke of a letter, or a tick. And only if it stands between
 * text: on `HOLDS` rows beside it a cell starts left of it, and on as many a cell starts in the
 * column it opens. A box's sides have text on one side only, and taken for columns, the sides of
 * two boxes on one of Rolls's pages joined them into one table the height of the page, and every
 * sentence between them became a row of it.
 */
export function columnsFromRules(rules: readonly Rule[], rows: readonly Row[]): RuledColumn[] {
  const leftmost = Math.min(...rows.flatMap((row) => row.cells.map((cell) => cell.left)), 0);
  const line = median(rows.map((row) => row.top - row.bottom).filter((height) => height > 0));
  const long = rules
    .filter((rule) => rule.x > leftmost + 3 && rule.top - rule.bottom >= RULE_LINE * line)
    .sort((a, b) => a.x - b.x);
  // Rules a hair apart across stand at one edge, and whether text stands either side of an edge is
  // judged over all its rules together: a rule drawn only on the rows it divides is a row tall.
  const edges: Rule[][] = [];
  for (const rule of long) {
    const edge = edges.at(-1);
    if (edge && rule.x - (edge[0]?.x ?? rule.x) <= 3) edge.push(rule);
    else edges.push([rule]);
  }
  const standing = edges
    .filter((edge, i) => {
      const at = edge[0]?.x ?? 0;
      const to = edges[i + 1]?.[0]?.x ?? Number.POSITIVE_INFINITY;
      const beside = rows.filter((row) => {
        const middle = (row.top + row.bottom) / 2;
        return edge.some((rule) => middle >= rule.bottom - PAST && middle <= rule.top + PAST);
      });
      const left = beside.filter((row) => row.cells.some((cell) => cell.left < at - PAST));
      const right = beside.filter((row) =>
        row.cells.some((cell) => cell.left >= at - PAST && cell.left < to),
      );
      return left.length >= HOLDS && right.length >= HOLDS;
    })
    .flat();
  // A rule runs past the rows of the whole table it belongs to, not only the rows it is drawn
  // beside: a rule broken for a cell drawn across it can stay broken to the table's foot, as
  // EPEVER's does under its last rows, where XTRA1206N and XTRA2206N share their static losses.
  // Rules whose heights meet are one table, however many meet through one another.
  const tables: { bottom: number; top: number; rules: Rule[] }[] = [];
  for (const rule of [...standing].sort((a, b) => a.bottom - b.bottom)) {
    const table = tables.at(-1);
    if (table && rule.bottom <= table.top + PAST) {
      table.top = Math.max(table.top, rule.top);
      table.rules.push(rule);
    } else tables.push({ bottom: rule.bottom, top: rule.top, rules: [rule] });
  }
  const columns: RuledColumn[] = [];
  for (const table of tables)
    for (const rule of table.rules) {
      const column = columns.find((c) => Math.abs(c.at - rule.x) <= 3);
      const span = { bottom: table.bottom, top: table.top };
      if (!column) columns.push({ at: rule.x, spans: [span] });
      else if (!column.spans.some((s) => s.bottom === span.bottom && s.top === span.top))
        column.spans.push(span);
    }
  return [
    { at: leftmost, spans: [{ bottom: Number.NEGATIVE_INFINITY, top: Number.POSITIVE_INFINITY }] },
    ...columns.sort((a, b) => a.at - b.at),
  ];
}

export function markdownOf(chars: readonly Char[], rules: readonly Rule[] = []): string {
  const facing = new Map<number, Char[]>();
  for (const char of chars) {
    const turn = quarterTurn(char);
    const side = facing.get(turn);
    if (side) side.push(turned(char, turn));
    else facing.set(turn, [turned(char, turn)]);
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
  // A ruled table says where its columns are; an unruled one is read from where its text sits.
  const ruled = rules.length >= 2 ? columnsFromRules(rules, rows) : [];
  const columns = ruled.length >= 2 ? ruled.map((column) => column.at) : columnsOf(rows);
  const grid =
    columns.length < 2 ? [] : gridOf(rows, columns, ruled.length >= 2 ? ruled : undefined);
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
    const joined =
      filled === 2 && /^\d+(\.\d+)*[.)]?$/.test(line[0] ?? "")
        ? line.filter((c) => c).join(" ")
        : undefined;
    // "12" and "V" is a figure in two cells, not a section number and its name.
    const numbered = joined && NUMBERED.test(joined) ? joined : undefined;
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

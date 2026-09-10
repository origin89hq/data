import type { Dialect, DialectModel } from "@origin89/equipment-schema/dialect";
import type {
  Confidence,
  Family as FamilyId,
  RefuterStatus,
} from "@origin89/equipment-schema/enums";
import type { Family } from "@origin89/equipment-schema/family";

/** The catalogue's fixed cross-reference paragraph, after the ids. Identical in every file. */
export const SEE_ALSO_TAIL =
  "— one device may\nhave arrived under more than one id, because parallel research agents\ncannot see each other's output. Left unmerged: collapsing them without\nre-reading the sources would destroy evidence to tidy a list.";

/** The refuter's fixed verdict when a grouping lost its evidence. */
export const CLAIM_DROPPED =
  "Its shared-register-map claim was dropped with it: these models are\nlisted together because one agent proposed it, not because a source\nshows matching addresses.";

export const REFILED_HEAD =
  "**Refiled from the family label they were researched under.** Either\nthe label named a family this catalogue does not declare, or it named\none whose framing was wrong for them — Modbus TCP is neither RS-485\nnor HTTP, and both of its former homes said so about the other:";

export const DUPLICATES_HEAD =
  "**Possible duplicates, not merged.** Parallel research agents cannot see\neach other's output, so one device can arrive under two ids. These were\nleft as found — merging them without re-reading the sources would destroy\nevidence to tidy a list:";

export interface ParsedFile {
  family: Family;
  dialects: Dialect[];
  /** What the hand-written count line claimed, so a mismatch with the records is visible. */
  claimedCount: number;
}

export class CatalogueParseError extends Error {
  readonly family: string;
  readonly dialect: string | undefined;
  constructor(family: string, dialect: string | undefined, message: string) {
    super(dialect ? `${family}/${dialect}: ${message}` : `${family}: ${message}`);
    this.family = family;
    this.dialect = dialect;
  }
}

const HEADING = /^##+ Dialect: `([^`]+)`$/;

/** Parse one family file. Sources are keyed by the id `sourceId` assigns; the caller owns the source table. */
export function parseFamilyFile(
  family: FamilyId,
  text: string,
  sourceId: (citation: string) => string,
): ParsedFile {
  const firstHeading = text.search(/^##+ Dialect: /m);
  if (firstHeading < 0) throw new CatalogueParseError(family, undefined, "no dialect entries");
  const preamble = text.slice(0, firstHeading);
  const body = text.slice(firstHeading);

  const { intro, claimedCount, refiled, duplicates } = parsePreamble(family, preamble);

  const chunks = body.split(/^(?=##+ Dialect: )/m);
  const dialects: Dialect[] = [];
  const sections: Family["sections"] = [];
  let pendingSection: string | undefined;
  for (const chunk of chunks) {
    const separator = chunk.indexOf("\n---\n");
    if (separator < 0)
      throw new CatalogueParseError(family, undefined, "entry without a closing rule");
    const entry = chunk.slice(0, separator);
    const trailing = chunk.slice(separator + "\n---\n".length).trim();
    const dialect = parseEntry(family, entry, sourceId);
    if (pendingSection) {
      sections.push({ before: dialect.id, markdown: pendingSection });
      pendingSection = undefined;
    }
    if (refiled.has(dialect.id)) dialect.refiledFrom = refiled.get(dialect.id);
    if (duplicates.has(dialect.id)) dialect.possibleDuplicate = true;
    dialects.push(dialect);
    if (trailing) pendingSection = trailing;
  }
  if (pendingSection)
    throw new CatalogueParseError(family, undefined, "prose after the last entry");
  for (const id of refiled.keys()) {
    if (!dialects.some((d) => d.id === id))
      throw new CatalogueParseError(
        family,
        id,
        "refiled list names an entry that is not in the file",
      );
  }
  for (const id of duplicates) {
    if (!dialects.some((d) => d.id === id))
      throw new CatalogueParseError(
        family,
        id,
        "duplicates list names an entry that is not in the file",
      );
  }
  const familyRecord: Family = {
    id: family,
    intro,
    ...(sections.length ? { sections } : {}),
    order: dialects.map((d) => d.id),
  };
  return { family: familyRecord, dialects, claimedCount };
}

function parsePreamble(family: FamilyId, preamble: string) {
  const countMatch = /^\*\*(\d+) dialects\*\* — .*$/m.exec(preamble);
  if (!countMatch) throw new CatalogueParseError(family, undefined, "no dialect count line");
  const intro = preamble.slice(0, countMatch.index).replace(/\n+$/, "");
  let rest = preamble.slice(countMatch.index + countMatch[0].length);
  const refiled = new Map<string, string>();
  const duplicates = new Set<string>();
  rest = rest.replace(/^\n+/, "");
  if (rest.startsWith(REFILED_HEAD)) {
    rest = rest.slice(REFILED_HEAD.length).replace(/^\n+/, "");
    for (;;) {
      const m = /^- `([^`]+)` — researched as `([^`]+)`\n/.exec(rest);
      if (!m) break;
      refiled.set(m[1], m[2]);
      rest = rest.slice(m[0].length);
    }
    rest = rest.replace(/^\n+/, "");
  }
  if (rest.startsWith(DUPLICATES_HEAD)) {
    rest = rest.slice(DUPLICATES_HEAD.length).replace(/^\n+/, "");
    for (;;) {
      const m = /^- `([^`]+)`\n/.exec(rest);
      if (!m) break;
      duplicates.add(m[1]);
      rest = rest.slice(m[0].length);
    }
    rest = rest.replace(/^\n+/, "");
  }
  if (rest.trim() !== "---")
    throw new CatalogueParseError(
      family,
      undefined,
      `unexpected preamble tail: ${JSON.stringify(rest.slice(0, 80))}`,
    );
  return { intro, claimedCount: Number(countMatch[1]), refiled, duplicates };
}

function parseEntry(family: FamilyId, entry: string, sourceId: (c: string) => string): Dialect {
  const paragraphs = entry.replace(/\n+$/, "").split(/\n\n+/);
  const heading = HEADING.exec(paragraphs[0] ?? "");
  if (!heading)
    throw new CatalogueParseError(
      family,
      undefined,
      `bad heading ${JSON.stringify(paragraphs[0])}`,
    );
  const id = heading[1];
  const fail = (message: string) => new CatalogueParseError(family, id, message);

  const d: Dialect = {
    id,
    family,
    driver: { status: "possible" },
    confidence: "unverified",
    refuter: "unrecorded",
    sources: [],
  };

  let i = 1;
  const seeAlsoParagraph = paragraphs[i];
  if (seeAlsoParagraph?.startsWith("**See also** ") && seeAlsoParagraph.endsWith(SEE_ALSO_TAIL)) {
    const ids = seeAlsoParagraph.slice("**See also** ".length, -SEE_ALSO_TAIL.length).trim();
    d.seeAlso = ids.split(", ").map((s) => {
      const m = /^`([^`]+)`$/.exec(s);
      if (!m) throw fail(`bad see-also id ${JSON.stringify(s)}`);
      return m[1];
    });
    i += 1;
  }

  const header = paragraphs[i];
  if (!header) throw fail("entry has no header paragraph");
  i += 1;
  for (const line of header.split("\n")) {
    const m = /^\*\*([A-Za-z ]+)\*\* (.*)$/.exec(line);
    if (!m) throw fail(`unrecognised header line ${JSON.stringify(line.slice(0, 60))}`);
    const [, label, value] = m;
    switch (label) {
      case "Driver":
        d.driver = parseDriver(value, fail);
        break;
      case "Confidence":
        Object.assign(d, parseConfidence(value, fail));
        break;
      case "Source":
        d.sources.push({ source: sourceId(value), citation: value });
        break;
      case "See also":
        d.crossReference = value;
        break;
      case "Transport":
        d.transport = value;
        break;
      case "Blocks":
        d.blocks = value;
        break;
      default:
        throw fail(`unknown header label ${label}`);
    }
  }
  if (d.sources.length === 0) throw fail("no sources");

  for (; i < paragraphs.length; i += 1) {
    const p = paragraphs[i];
    if (p.startsWith("`reports` ") || p.startsWith("`accepts` ")) {
      for (const line of p.split("\n")) {
        const m = /^`(reports|accepts)` (.*)$/.exec(line);
        if (!m) throw fail(`bad kinds line ${JSON.stringify(line.slice(0, 60))}`);
        const list = m[2].split(", ") as never[];
        if (m[1] === "reports") d.reports = list;
        else d.accepts = list;
      }
    } else if (p.startsWith("| Model")) {
      d.models = parseTable(p, fail);
    } else if (p.startsWith("**Shared-map evidence** ")) {
      d.sharedMapEvidence = p.slice("**Shared-map evidence** ".length);
    } else if (p.startsWith("**REFUTED on review.** ")) {
      d.refutedOnReview = p.slice("**REFUTED on review.** ".length);
    } else if (p === CLAIM_DROPPED) {
      d.sharedMapClaimDropped = true;
    } else if (p.startsWith("**Downgraded on review.** ")) {
      d.downgradedOnReview = p.slice("**Downgraded on review.** ".length);
    } else if (p.startsWith("- ")) {
      d.gotchas = p.split("\n").map((line) => {
        if (!line.startsWith("- "))
          throw fail(`gotcha continuation line ${JSON.stringify(line.slice(0, 60))}`);
        return line.slice(2);
      });
    } else if (p.startsWith("**Reports with no `MetricKind`:** ")) {
      d.unmappedReports = p.slice("**Reports with no `MetricKind`:** ".length);
    } else {
      throw fail(`unrecognised paragraph ${JSON.stringify(p.slice(0, 60))}`);
    }
  }
  return d;
}

function parseDriver(value: string, fail: (m: string) => Error): Dialect["driver"] {
  if (value === "💡 none") return { status: "possible" };
  const shipped = /^✅ `([^`]+)`$/.exec(value);
  if (shipped) return { status: "shipped", id: shipped[1] };
  throw fail(`unrecognised driver ${JSON.stringify(value)}`);
}

function parseConfidence(
  value: string,
  fail: (m: string) => Error,
): { confidence: Confidence; refuter: RefuterStatus; confidenceNote?: string } {
  const m = /^`([a-z-]+)`(.*)$/.exec(value);
  if (!m) throw fail(`unrecognised confidence ${JSON.stringify(value)}`);
  const confidence = m[1] as Confidence;
  const rest = m[2];
  if (rest === " · refuter checked") return { confidence, refuter: "checked" };
  if (rest === " · **not checked** — no refuter ran") return { confidence, refuter: "not-checked" };
  if (rest.trim() === "") return { confidence, refuter: "unrecorded" };
  return { confidence, refuter: "unrecorded", confidenceNote: rest.trim() };
}

const COLUMNS: Record<string, (keyof DialectModel)[]> = {
  "| Model |": ["name"],
  "| Model | Rating | Notes |": ["name", "rating", "notes"],
  "| Model | Tier | Rating | Sold by | Notes |": ["name", "tier", "rating", "soldBy", "notes"],
};

function parseTable(p: string, fail: (m: string) => Error): DialectModel[] {
  const lines = p.split("\n");
  const columns = COLUMNS[lines[0]];
  if (!columns) throw fail(`unknown table header ${JSON.stringify(lines[0])}`);
  if (lines[1] !== `|${"---|".repeat(columns.length)}`) throw fail("bad table rule");
  return lines.slice(2).map((line) => {
    if (!line.startsWith("| ") || !line.endsWith(" |"))
      throw fail(`bad table row ${JSON.stringify(line.slice(0, 60))}`);
    const cells = line.slice(2, -2).split(" | ");
    if (cells.length !== columns.length)
      throw fail(
        `row has ${cells.length} cells, header has ${columns.length}: ${JSON.stringify(line.slice(0, 60))}`,
      );
    const model: DialectModel = { name: cells[0] };
    columns.slice(1).forEach((column, index) => {
      const cell = cells[index + 1];
      if (cell !== "") (model as Record<string, string>)[column] = cell;
    });
    return model;
  });
}

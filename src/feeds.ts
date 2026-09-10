import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EquipmentKind } from "@origin89/equipment-schema/guess";

export const FEEDS_DIR = new URL("../feeds/", import.meta.url).pathname;

/**
 * A public dataset, redistributed here with its licence and pinned by hash. Twenty-five thousand
 * rows are not twenty-five thousand records: what is reviewed is the adapter and the pin, and the
 * build regenerates the rows every time. A changed file fails its hash rather than quietly
 * becoming a different dataset.
 */
export interface Feed {
  id: string;
  title: string;
  publisher: string;
  license: string;
  retrievedAt: string;
  files: { name: string; sha256: string; kind: EquipmentKind }[];
}

/** One row of a feed: a product with its figures, in the same shape the reviewed side uses. */
export interface FeedModel {
  id: string;
  feed: string;
  /** The maker's name as the dataset prints it. Resolving it to a manufacturer record is the gate's job, not a feed's. */
  manufacturerName: string;
  /** Set only when that name already answers to a manufacturer somebody confirmed. */
  manufacturer?: string;
  name: string;
  kind: EquipmentKind;
  specs: { name: string; value: string; unit?: string }[];
}

/**
 * Parse a CSV with quoted fields. Small and deliberate: these files are pinned by hash, so the
 * shape cannot change underneath without the build refusing it first.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Read a pinned file and refuse it if the bytes are not the ones that were reviewed. */
export function pinnedFile(dir: string, name: string, sha256: string): string {
  const bytes = readFileSync(join(dir, name));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256)
    throw new Error(
      `${name}: sha256 is ${actual}, the pin says ${sha256}; review the change and update the pin`,
    );
  return bytes.toString("utf8");
}

/** Figures worth keeping from a SAM row, and the unit the library's own units row gives. */
const KEEP: Record<string, string> = {
  STC: "Nameplate power at standard test conditions",
  PTC: "Power at PVUSA test conditions",
  I_sc_ref: "Short-circuit current",
  V_oc_ref: "Open-circuit voltage",
  I_mp_ref: "Current at maximum power",
  V_mp_ref: "Voltage at maximum power",
  N_s: "Cells in series",
  A_c: "Cell area",
  Length: "Length",
  Width: "Width",
  T_NOCT: "Nominal operating cell temperature",
  Vac: "AC voltage",
  Paco: "Maximum AC power output",
  Pdco: "DC power at rated AC output",
  Vdco: "DC voltage at rated AC output",
  Vdcmax: "Maximum DC voltage",
  Idcmax: "Maximum DC current",
  Mppt_low: "Lowest MPPT voltage",
  Mppt_high: "Highest MPPT voltage",
  Pnt: "Night tare loss",
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Read one SAM library. Row one is the column names, row two the units and row three the library's
 * internal keys, so a figure never needs a unit guessed for it — which is the whole reason this
 * feed is worth more per row than anything read out of a PDF.
 */
export function readSam(
  dir: string,
  file: { name: string; sha256: string; kind: EquipmentKind },
  feedId: string,
): FeedModel[] {
  const rows = parseCsv(pinnedFile(dir, file.name, file.sha256));
  const [header, units] = rows;
  const nameAt = header.indexOf("Name");
  const makerAt = header.indexOf("Manufacturer");
  if (nameAt < 0) throw new Error(`${file.name}: no Name column`);

  const out: FeedModel[] = [];
  for (const row of rows.slice(3)) {
    const name = row[nameAt]?.trim();
    if (!name) continue;
    // An inverter's name carries its maker: "ABB: PVI-30-OUTD-S-US-A {240V}". A module's does not,
    // and the Manufacturer column holds it instead.
    const colon = name.indexOf(":");
    const maker =
      (makerAt >= 0 ? row[makerAt]?.trim() : "") || (colon > 0 ? name.slice(0, colon).trim() : "");
    const model = colon > 0 && makerAt < 0 ? name.slice(colon + 1).trim() : name;
    const specs = header
      .map((column, i) => ({ column, value: row[i]?.trim() ?? "", unit: units[i]?.trim() ?? "" }))
      .filter((c) => KEEP[c.column] && c.value !== "" && c.value !== "0")
      .map((c) => ({ name: KEEP[c.column], value: c.value, ...(c.unit ? { unit: c.unit } : {}) }));
    if (specs.length === 0) continue;
    out.push({
      id: `${feedId}-${slug(maker || "unknown")}-${slug(model)}`.slice(0, 150),
      feed: feedId,
      manufacturerName: maker || "unknown",
      name: model,
      kind: file.kind,
      specs,
    });
  }
  return out;
}

/**
 * Attach a feed row to a manufacturer somebody confirmed, when its printed name answers to one.
 * A name that does not is left as a name: a feed does not get to mint makers, which is the gate's
 * decision, and a thousand new manufacturer records would be exactly the guessing it prevents.
 */
export function attachMakers(
  models: FeedModel[],
  makers: { id: string; name: string; aliases?: string[] }[],
): FeedModel[] {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byKey = new Map<string, string>();
  for (const m of makers) {
    byKey.set(key(m.name), m.id);
    // A maker's name here is often longer than the one a dataset prints: "EPEver (Beijing
    // Epsolar Technology)" has to be reachable as "EPEver".
    const short = m.name.replace(/\s*\(.*\)\s*$/, "").trim();
    if (short) byKey.set(key(short), m.id);
    for (const alias of m.aliases ?? []) byKey.set(key(alias), m.id);
  }
  return models.map((m) => {
    const id = byKey.get(key(m.manufacturerName));
    return id ? { ...m, manufacturer: id } : m;
  });
}

/** Every row of every pinned feed. */
export function readFeeds(dir = FEEDS_DIR): { feed: Feed; models: FeedModel[] }[] {
  const out: { feed: Feed; models: FeedModel[] }[] = [];
  for (const id of ["sam-cec"]) {
    const feed = JSON.parse(readFileSync(join(dir, id, "source.json"), "utf8")) as Feed;
    const models: FeedModel[] = [];
    for (const file of feed.files) models.push(...readSam(join(dir, id), file, feed.id));
    out.push({ feed, models });
  }
  return out;
}

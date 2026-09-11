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
  /** The upstream repository and the commit the pinned files were taken from. */
  repository: string;
  commit: string;
  retrievedAt: string;
  files: FeedFile[];
}

export interface FeedFile {
  name: string;
  sha256: string;
  kind: EquipmentKind;
}

/** One row of a feed: a product with its figures, in the same shape the records use. */
export interface FeedModel {
  id: string;
  feed: string;
  /** The source record for the file this row was read from, so a figure cites the file and its hash. */
  source: string;
  /** The maker's name as the dataset prints it. Resolving it to a manufacturer record is the gate's job, not a feed's. */
  manufacturerName: string;
  /** Set only when that name already answers to a manufacturer somebody confirmed. */
  manufacturer?: string;
  name: string;
  kind: EquipmentKind;
  specs: { name: string; value: string; unit?: string; conditions?: string }[];
}

/**
 * A feed file as a source: the file at the pinned commit, with the hash the pin states. Every
 * figure names a source, and a feed's figures used to name the feed itself, which is not in
 * `sources`; a consumer joining the two lost every one of them.
 */
export function feedSource(feed: Feed, file: FeedFile): FeedSource {
  return {
    id: `${feed.id}-${slug(file.name.replace(/\.[a-z0-9]+$/i, ""))}`,
    url: feedFileUrl(feed.commit, file.name),
    title: `${feed.title}: ${file.name}`,
    publisher: feed.publisher,
    revision: feed.commit,
    sha256: file.sha256,
    retrievedAt: feed.retrievedAt,
    // Redistributed under the feed's own licence, kept beside it in `feeds/`.
    redistributable: true,
  };
}

export interface FeedSource {
  id: string;
  url: string;
  title: string;
  publisher: string;
  revision: string;
  sha256: string;
  retrievedAt: string;
  redistributable: boolean;
}

/** Where a SAM library file lives at one commit; `sync-sam` fetches from the same place. */
export function feedFileUrl(ref: string, name: string): string {
  return `https://raw.githubusercontent.com/NatLabRockies/SAM/${ref}/deploy/libraries/${encodeURIComponent(name)}`;
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

/** Standard test conditions, which is what every rated figure on a module is measured at. */
const STC = "STC: 1000 W/m², cell 25 °C, AM 1.5";
/** PVUSA test conditions, which put the module in a plausible field rather than a lab. */
const PTC = "PTC: 1000 W/m², ambient 20 °C, wind 1 m/s";

/**
 * Figures worth keeping from a SAM row. The unit comes from the library's own units row, except
 * where that row is blank: it leaves STC and PTC without a unit, and SAM's help documents both
 * as watts ("Nominal Power (W)" for STC, "PTC (W)"), so the unit is stated here with that as its
 * source rather than left off and doubted on every one of twenty thousand rows.
 */
const KEEP: Record<string, { name: string; unit?: string; conditions?: string }> = {
  STC: { name: "Nameplate power at standard test conditions", unit: "W", conditions: STC },
  PTC: { name: "Power at PVUSA test conditions", unit: "W", conditions: PTC },
  I_sc_ref: { name: "Short-circuit current", conditions: STC },
  V_oc_ref: { name: "Open-circuit voltage", conditions: STC },
  I_mp_ref: { name: "Current at maximum power", conditions: STC },
  V_mp_ref: { name: "Voltage at maximum power", conditions: STC },
  // The coefficients are what turn an STC figure into one at a cold morning's temperature, and a
  // string-voltage check without them is a guess about the one condition it exists to check.
  alpha_sc: { name: "Temperature coefficient of short-circuit current" },
  beta_oc: { name: "Temperature coefficient of open-circuit voltage" },
  gamma_pmp: { name: "Temperature coefficient of maximum power" },
  N_s: { name: "Cells in series" },
  A_c: { name: "Cell area" },
  Length: { name: "Length" },
  Width: { name: "Width" },
  T_NOCT: { name: "Nominal operating cell temperature" },
  Vac: { name: "AC voltage" },
  Paco: { name: "Maximum AC power output" },
  Pdco: { name: "DC power at rated AC output" },
  Vdco: { name: "DC voltage at rated AC output" },
  Vdcmax: { name: "Maximum DC voltage" },
  Idcmax: { name: "Maximum DC current" },
  Mppt_low: { name: "Lowest MPPT voltage" },
  Mppt_high: { name: "Highest MPPT voltage" },
  Pnt: { name: "Night tare loss" },
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
export function readSam(dir: string, file: FeedFile, feed: Feed): FeedModel[] {
  const rows = parseCsv(pinnedFile(dir, file.name, file.sha256));
  const [header, units] = rows;
  const nameAt = header.indexOf("Name");
  const makerAt = header.indexOf("Manufacturer");
  if (nameAt < 0) throw new Error(`${file.name}: no Name column`);

  const source = feedSource(feed, file).id;
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
      .map((column, i) => ({
        keep: KEEP[column],
        value: row[i]?.trim() ?? "",
        unit: KEEP[column]?.unit ?? units[i]?.trim() ?? "",
      }))
      // An empty cell, a zero and a NaN are the library's three ways of stating nothing.
      .filter((c) => c.keep && c.value !== "" && c.value !== "0" && c.value !== "NaN")
      .map((c) => ({
        name: c.keep.name,
        value: c.value,
        ...(c.unit ? { unit: c.unit } : {}),
        ...(c.keep.conditions ? { conditions: c.keep.conditions } : {}),
      }));
    if (specs.length === 0) continue;
    out.push({
      id: `${feed.id}-${slug(maker || "unknown")}-${slug(model)}`.slice(0, 150),
      feed: feed.id,
      source,
      manufacturerName: maker || "unknown",
      name: model,
      kind: file.kind,
      specs,
    });
  }
  return uniqueIds(out);
}

/**
 * Give a repeated id a suffix, in file order, so both rows survive. The CEC library lists some
 * product names twice with different figures, and a keyed store keeps one of two rows with one
 * id and says nothing about the other. The suffix skips any id the file already uses, so a
 * product named "X 2" cannot be mistaken for the second "X".
 */
export function uniqueIds(models: FeedModel[]): FeedModel[] {
  const taken = new Set(models.map((m) => m.id));
  const seen = new Set<string>();
  return models.map((m) => {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      return m;
    }
    let n = 2;
    while (taken.has(`${m.id}-${n}`) || seen.has(`${m.id}-${n}`)) n += 1;
    const id = `${m.id}-${n}`;
    seen.add(id);
    return { ...m, id };
  });
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
    for (const file of feed.files) models.push(...readSam(join(dir, id), file, feed));
    out.push({ feed, models });
  }
  return out;
}

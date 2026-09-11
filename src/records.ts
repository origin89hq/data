import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Brand } from "@origin89/equipment-schema/brand";
import { Dialect } from "@origin89/equipment-schema/dialect";
import { Family as FamilyId } from "@origin89/equipment-schema/enums";
import { Family } from "@origin89/equipment-schema/family";
import { Manufacturer } from "@origin89/equipment-schema/manufacturer";
import { Mapping } from "@origin89/equipment-schema/mapping";
import { Model, Spec } from "@origin89/equipment-schema/model";
import { Source } from "@origin89/equipment-schema/source";

export const RECORDS_DIR = new URL("../records/", import.meta.url).pathname;

export interface Records {
  families: Family[];
  dialects: Dialect[];
  sources: Source[];
  manufacturers: Manufacturer[];
  brands: Brand[];
  models: Model[];
  specs: Spec[];
  /** How each maker's printed figures reach the property registry, one file per maker. */
  mappings: Mapping[];
}

/** A record's file, so a validation message can name the line to open. */
export interface Located<T> {
  path: string;
  record: T;
}

/** Read every record and parse it against its schema. A file that fails its schema stops the load with its path. */
export function loadRecords(dir = RECORDS_DIR): Records {
  const families = readJsonDir(join(dir, "families"), Family);
  const dialects = FamilyId.options.flatMap((family) =>
    readJsonDir(join(dir, "dialects", family), Dialect),
  );
  const sources = readJsonDir(join(dir, "sources"), Source);
  const manufacturers = readJsonDir(join(dir, "manufacturers"), Manufacturer);
  const brands = readJsonDir(join(dir, "brands"), Brand);
  const models = readJsonDir(join(dir, "models"), Model);
  const specs = readJsonDir(join(dir, "specs"), Spec);
  const mappings = readJsonDir(join(dir, "mappings"), Mapping);
  return { families, dialects, sources, manufacturers, brands, models, specs, mappings };
}

function readJsonDir<T>(dir: string, schema: { parse(value: unknown): T }): T[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = join(dir, name);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    try {
      const record = schema.parse(raw);
      const id = (record as { id?: string }).id;
      if (id !== undefined && `${id}.json` !== name)
        throw new Error(`id ${JSON.stringify(id)} does not match filename`);
      return record;
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Write one record file, creating its directory. Used by the importer and the gate. */
export function writeRecord(dir: string, kind: string, id: string, value: unknown): string {
  const path = join(dir, kind, `${id}.json`);
  writeJson(path, value);
  return path;
}

/** The record kinds, each its own directory. A writer names the ones it owns and leaves the rest alone. */
export type Kind =
  | "families"
  | "dialects"
  | "sources"
  | "manufacturers"
  | "brands"
  | "models"
  | "specs"
  | "mappings";
export const KINDS: Kind[] = [
  "families",
  "dialects",
  "sources",
  "manufacturers",
  "brands",
  "models",
  "specs",
  "mappings",
];

/**
 * Replace whole record kinds from `records`. Only the kinds in `replace` are touched: the
 * catalogue importer rewrites families, dialects and sources every run, and must not take the
 * gate's hand-reviewed manufacturers and brands with them.
 */
export function writeRecords(records: Records, dir = RECORDS_DIR, replace: Kind[] = KINDS): void {
  for (const sub of replace) rmSync(join(dir, sub), { recursive: true, force: true });
  const write = <T>(kind: Kind, items: T[], id: (item: T) => string, sub?: (item: T) => string) => {
    if (!replace.includes(kind)) return;
    for (const item of items)
      writeJson(join(dir, kind, ...(sub ? [sub(item)] : []), `${id(item)}.json`), item);
  };
  write("families", records.families, (f) => f.id);
  write(
    "dialects",
    records.dialects,
    (d) => d.id,
    (d) => d.family,
  );
  write("sources", records.sources, (s) => s.id);
  write("manufacturers", records.manufacturers, (m) => m.id);
  write("brands", records.brands, (b) => b.id);
  write(
    "models",
    records.models,
    (m) => m.id,
    (m) => m.manufacturer,
  );
  write(
    "specs",
    records.specs,
    (s) => s.id,
    (s) => s.model,
  );
  write("mappings", records.mappings, (m) => m.id);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

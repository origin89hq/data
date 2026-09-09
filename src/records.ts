import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Dialect } from "../schema/dialect.ts";
import { Family } from "../schema/family.ts";
import { Source } from "../schema/source.ts";
import { Family as FamilyId } from "../schema/enums.ts";

export const RECORDS_DIR = new URL("../records/", import.meta.url).pathname;

export interface Records {
  families: Family[];
  dialects: Dialect[];
  sources: Source[];
}

/** A record's file, so a validation message can name the line to open. */
export interface Located<T> {
  path: string;
  record: T;
}

/** Read every record and parse it against its schema. A file that fails its schema stops the load with its path. */
export function loadRecords(dir = RECORDS_DIR): Records {
  const families = readJsonDir(join(dir, "families"), Family);
  const dialects = FamilyId.options.flatMap((family) => readJsonDir(join(dir, "dialects", family), Dialect));
  const sources = readJsonDir(join(dir, "sources"), Source);
  return { families, dialects, sources };
}

function readJsonDir<T>(dir: string, schema: { parse(value: unknown): T }): T[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = join(dir, name);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    try {
      const record = schema.parse(raw);
      const id = (record as { id?: string }).id;
      if (id !== undefined && `${id}.json` !== name) throw new Error(`id ${JSON.stringify(id)} does not match filename`);
      return record;
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Write records with a fixed key order and trailing newline, so a re-import of unchanged input is an empty diff. */
export function writeRecords(records: Records, dir = RECORDS_DIR): void {
  for (const sub of ["families", "dialects", "sources"]) rmSync(join(dir, sub), { recursive: true, force: true });
  for (const family of records.families) writeJson(join(dir, "families", `${family.id}.json`), family);
  for (const dialect of records.dialects) writeJson(join(dir, "dialects", dialect.family, `${dialect.id}.json`), dialect);
  for (const source of records.sources) writeJson(join(dir, "sources", `${source.id}.json`), source);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

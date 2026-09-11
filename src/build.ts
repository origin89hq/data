import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORD_SNAPSHOT_MAX, RecordKind, snapshotName } from "@origin89/equipment-schema/releases";
import { toCsv } from "./csv.ts";
import { loadRecords, type Records } from "./records.ts";
import { duplicateIds, type Table, tables } from "./tables.ts";
import { validate } from "./validate.ts";

export const DIST_DIR = new URL("../dist/", import.meta.url).pathname;

/**
 * Emit the release: one CSV and one Parquet per table, the nested dialect JSON, and a
 * manifest with a hash of each. No timestamp anywhere, so the same records build the same bytes.
 */
export function build(records: Records, dist = DIST_DIR): Record<string, unknown> {
  const report = validate(records);
  if (report.errors.length)
    throw new Error(
      `refusing to build with ${report.errors.length} validation errors; run validate`,
    );
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const manifest: Record<string, unknown> = {
    counts: {
      families: records.families.length,
      dialects: records.dialects.length,
      sources: records.sources.length,
    },
    files: {} as Record<string, { rows?: number; sha256: string; bytes: number }>,
  };
  const files = manifest.files as Record<string, { rows?: number; sha256: string; bytes: number }>;
  const record = (name: string, rows?: number) => {
    const bytes = readFileSync(join(dist, name));
    files[name] = {
      ...(rows === undefined ? {} : { rows }),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  };

  for (const table of tables(records)) {
    const repeated = duplicateIds(table);
    if (repeated.length)
      throw new Error(
        `refusing to build: ${table.name} repeats ${repeated.length} ids, first ${repeated[0]}`,
      );
    const csv = `${table.name}.csv`;
    writeFileSync(
      join(dist, csv),
      toCsv(
        table.columns.map((c) => c.name),
        table.rows,
      ),
    );
    record(csv, table.rows.length);
    writeParquet(dist, table);
    record(`${table.name}.parquet`, table.rows.length);
  }
  writeFileSync(join(dist, "dialects.json"), `${JSON.stringify(records.dialects, null, 2)}\n`);
  record("dialects.json", records.dialects.length);
  writeFileSync(join(dist, "sources.json"), `${JSON.stringify(records.sources, null, 2)}\n`);
  record("sources.json", records.sources.length);
  for (const kind of RecordKind.options) {
    const name = snapshotName(kind);
    const snapshot = JSON.stringify(records[kind]);
    if (Buffer.byteLength(snapshot) > RECORD_SNAPSHOT_MAX)
      throw new Error(
        `${name} exceeds the supported snapshot size; shard snapshots before growing this release`,
      );
    writeFileSync(join(dist, name), snapshot);
    record(name, records[kind].length);
  }
  writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** DuckDB reads the CSV with the declared column types. A missing `duckdb` binary fails the build; it does not skip the file. */
function writeParquet(dist: string, table: Table): void {
  const columns = table.columns.map((c) => `'${c.name}': '${c.type}'`).join(", ");
  const sql = `COPY (SELECT * FROM read_csv('${join(dist, table.name)}.csv', header = true, columns = {${columns}}, quote = '"', escape = '"', delim = ',', nullstr = '')) TO '${join(dist, table.name)}.parquet' (FORMAT parquet, COMPRESSION zstd);`;
  try {
    execFileSync("duckdb", ["-c", sql], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(`parquet for ${table.name}: ${stderr.trim() || "duckdb is not installed"}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const manifest = build(loadRecords());
  for (const [name, f] of Object.entries(
    manifest.files as Record<string, { rows?: number; bytes: number }>,
  )) {
    console.log(
      `${name.padEnd(28)} ${String(f.rows ?? "").padStart(5)} rows ${String(f.bytes).padStart(9)} bytes`,
    );
  }
}

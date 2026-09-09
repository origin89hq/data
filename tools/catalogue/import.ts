import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Family } from "../../schema/enums.ts";
import { writeRecords, RECORDS_DIR } from "../../src/records.ts";
import { parseFamilyFile } from "./parse.ts";
import { SourceTable } from "./sources.ts";
import type { Dialect } from "../../schema/dialect.ts";
import type { Family as FamilyRecord } from "../../schema/family.ts";

/**
 * One-time migration: read the origin89 catalogue and write it as records. Re-running on the
 * same input rewrites identical files. Usage: import.ts <origin89 docs/catalog dir>
 */
const [catalogueDir] = process.argv.slice(2);
if (!catalogueDir) {
  console.error("usage: import.ts <catalogue dir>");
  process.exit(2);
}
const sources = new SourceTable();
const families: FamilyRecord[] = [];
const dialects: Dialect[] = [];
for (const family of Family.options) {
  const text = readFileSync(join(catalogueDir, `${family}.md`), "utf8");
  const parsed = parseFamilyFile(family, text, (c) => sources.idFor(c));
  if (parsed.claimedCount !== parsed.dialects.length) {
    console.error(`${family}: count line says ${parsed.claimedCount}, file holds ${parsed.dialects.length}`);
    process.exit(1);
  }
  families.push(parsed.family);
  dialects.push(...parsed.dialects);
}
writeRecords({ families, dialects, sources: sources.all() }, RECORDS_DIR);
console.log(`${families.length} families, ${dialects.length} dialects, ${sources.all().length} sources → ${RECORDS_DIR}`);

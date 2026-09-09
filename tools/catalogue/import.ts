import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Family } from "../../schema/enums.ts";
import { loadRecords, writeRecords, RECORDS_DIR } from "../../src/records.ts";
import { parseFamilyFile } from "./parse.ts";
import { SourceTable } from "./sources.ts";
import type { Dialect } from "../../schema/dialect.ts";
import type { Family as FamilyRecord } from "../../schema/family.ts";

/**
 * One-time migration: read the catalogue's markdown form and write it as records. Re-running on the
 * same input rewrites identical files. Usage: import.ts <catalogue dir>
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
// Only the kinds this importer owns. Manufacturers and brands are reviewed by hand and are
// not the catalogue's to rewrite; passing them here once would have deleted the whole gate.
const existing = loadRecords(RECORDS_DIR);
writeRecords({ ...existing, families, dialects, sources: sources.all() }, RECORDS_DIR, ["families", "dialects", "sources"]);
console.log(`${families.length} families, ${dialects.length} dialects, ${sources.all().length} sources → ${RECORDS_DIR}`);
console.log(`left alone: ${existing.manufacturers.length} manufacturers, ${existing.brands.length} brands`);

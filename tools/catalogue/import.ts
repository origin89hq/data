import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dialect } from "@origin89/equipment-schema/dialect";
import { Family } from "@origin89/equipment-schema/enums";
import type { Family as FamilyRecord } from "@origin89/equipment-schema/family";
import { loadRecords, RECORDS_DIR, writeRecords } from "../../src/records.ts";
import { parseFamilyFile } from "./parse.ts";
import { withExtensions } from "./preserve.ts";
import { SourceTable } from "./sources.ts";

/**
 * Read the catalogue's markdown form and write it as records. Re-running on the same input
 * rewrites identical files; what the markdown does not carry, a dialect's structured readings
 * and code tables and the sources only they cite, is kept from the records being replaced.
 * Usage: import.ts <catalogue dir>
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
    console.error(
      `${family}: count line says ${parsed.claimedCount}, file holds ${parsed.dialects.length}`,
    );
    process.exit(1);
  }
  families.push(parsed.family);
  dialects.push(...parsed.dialects);
}
// Only the kinds this importer owns. Manufacturers and brands are reviewed by hand and are
// not the catalogue's to rewrite; passing them here once would have deleted the whole gate.
const existing = loadRecords(RECORDS_DIR);
const kept = withExtensions(dialects, existing.dialects, sources.all(), existing.sources);
writeRecords(
  { ...existing, families, dialects: kept.dialects, sources: kept.sources },
  RECORDS_DIR,
  ["families", "dialects", "sources"],
);
console.log(
  `${families.length} families, ${kept.dialects.length} dialects, ${kept.sources.length} sources → ${RECORDS_DIR}`,
);
console.log(
  `kept from the records: readings on ${kept.dialects.filter((d) => d.readings).length} dialects, codes on ${kept.dialects.filter((d) => d.codes).length}`,
);
console.log(
  `left alone: ${existing.manufacturers.length} manufacturers, ${existing.brands.length} brands, ${existing.models.length} models, ${existing.specs.length} specs`,
);

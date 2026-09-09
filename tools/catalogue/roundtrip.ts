import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Family } from "../../schema/enums.ts";
import { parseFamilyFile } from "./parse.ts";
import { renderFamilyFile } from "./render.ts";
import { SourceTable } from "./sources.ts";

/**
 * Parse every family file and render it back. A byte-identical result is the proof that the
 * records hold everything the prose held. Usage: roundtrip.ts <origin89 docs/catalog dir> [out dir]
 */
const [catalogueDir, outDir] = process.argv.slice(2);
if (!catalogueDir) {
  console.error("usage: roundtrip.ts <catalogue dir> [out dir]");
  process.exit(2);
}
const sources = new SourceTable();
let failures = 0;
for (const family of Family.options) {
  const path = join(catalogueDir, `${family}.md`);
  const original = readFileSync(path, "utf8");
  const parsed = parseFamilyFile(family, original, (c) => sources.idFor(c));
  const rendered = renderFamilyFile(parsed.family, new Map(parsed.dialects.map((d) => [d.id, d])));
  const same = rendered === original;
  const countOk = parsed.claimedCount === parsed.dialects.length;
  console.log(`${same ? "same" : "DIFF"} ${countOk ? "" : `count claimed ${parsed.claimedCount}, found ${parsed.dialects.length} `}${family} (${parsed.dialects.length} dialects)`);
  if (!same) failures += 1;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${family}.md`), rendered);
  }
}
console.log(`${sources.all().length} sources`);
process.exit(failures ? 1 : 0);

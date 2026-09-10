import { writeFileSync } from "node:fs";
import { loadRecords } from "../../src/records.ts";

/**
 * Write the manufacturers the Worker is allowed to reach. Records live in git and a Worker cannot
 * read git, so the list crosses over as a bundled file — the same way the seller list does.
 *
 * Only makers that claim a domain are exported: a manufacturer with none has nothing for
 * discovery to look at, and shipping it would be shipping an instance that must fail.
 */
const path = new URL("../../apps/worker/manufacturers.json", import.meta.url);
const makers = loadRecords()
  .manufacturers.filter((m) => m.domains.length > 0)
  .map((m) => ({ id: m.id, domains: m.domains }))
  .sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(path, `${JSON.stringify(makers, null, 2)}\n`);
console.log(`${makers.length} manufacturers with a domain → apps/worker/manufacturers.json`);

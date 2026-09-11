import { writeFileSync } from "node:fs";
import { citedFor, sourceIdsCitedBy } from "../../src/cited.ts";
import { loadRecords } from "../../src/records.ts";

/**
 * Write the manufacturers the Worker is allowed to reach. Records live in git and a Worker cannot
 * read git, so the list crosses over as a bundled file — the same way the seller list does.
 *
 * Only makers that claim a domain are exported: a manufacturer with none has nothing for
 * discovery to look at, and shipping it would be shipping an instance that must fail. Each maker
 * carries what the records already cite on its hosts, so discovery can offer a known datasheet
 * even when the site's sitemap does not lead to it.
 */
const path = new URL("../../apps/worker/manufacturers.json", import.meta.url);
const records = loadRecords();
const makers = records.manufacturers
  .filter((m) => m.domains.length > 0)
  .map((m) => {
    const cited = citedFor(m, records.sources, sourceIdsCitedBy(m.id, records));
    return {
      id: m.id,
      domains: m.domains,
      ...(m.documentHosts?.length ? { documentHosts: m.documentHosts } : {}),
      ...(cited.documents.length || cited.pages.length ? { cited } : {}),
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(path, `${JSON.stringify(makers, null, 2)}\n`);
const cited = makers.filter((m) => m.cited).length;
console.log(
  `${makers.length} manufacturers with a domain, ${cited} with cited sources → apps/worker/manufacturers.json`,
);

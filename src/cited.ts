import type { Dialect } from "@origin89/equipment-schema/dialect";
import { hostAllowed, isDocument } from "@origin89/equipment-schema/documents";
import type { Manufacturer } from "@origin89/equipment-schema/manufacturer";
import type { Model, Spec } from "@origin89/equipment-schema/model";
import type { Source } from "@origin89/equipment-schema/source";

/** Source URLs on a maker's own hosts: documents to offer, and pages to read for more. */
export interface Cited {
  documents: string[];
  pages: string[];
}

/**
 * The sources a maker's own records cite: its record, its dialects, the figures of its models
 * and the evidence on its models' links to dialects. A retailer's page cited by an EPEVER
 * dialect is EPEVER's evidence, not the retailer's, and a crawl of the retailer must not read
 * it as its own (#30).
 */
export function sourceIdsCitedBy(
  makerId: string,
  records: {
    manufacturers: readonly Manufacturer[];
    dialects: readonly Dialect[];
    models: readonly Model[];
    specs: readonly Spec[];
  },
): Set<string> {
  const ids = new Set<string>();
  for (const id of records.manufacturers.find((m) => m.id === makerId)?.sources ?? []) ids.add(id);
  for (const dialect of records.dialects)
    if (dialect.manufacturer === makerId) for (const c of dialect.sources) ids.add(c.source);
  const own = records.models.filter((m) => m.manufacturer === makerId);
  const models = new Set(own.map((m) => m.id));
  for (const spec of records.specs) if (models.has(spec.model)) ids.add(spec.source);
  for (const m of own)
    for (const link of m.dialects) for (const c of link.evidence.sources) ids.add(c.source);
  return ids;
}

/**
 * What the records already cite on a maker's hosts. A person found these once and wrote them
 * down, so discovery offers them whether or not the site's sitemap leads to them: EPEVER's
 * XTRA-N G3 datasheet and manual are cited by a dialect record and were never in a plan (#48).
 * A source held only by path, with no URL, is not on any host and is left alone. With `only`,
 * a source is taken only when one of the maker's own records cites it.
 */
export function citedFor(
  maker: Pick<Manufacturer, "domains">,
  sources: readonly Source[],
  only?: ReadonlySet<string>,
): Cited {
  const documents = new Set<string>();
  const pages = new Set<string>();
  for (const source of sources) {
    if (!source.url) continue;
    if (only && !only.has(source.id)) continue;
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (!hostAllowed(url.hostname, maker.domains)) continue;
    url.hash = "";
    (isDocument(url.toString()) ? documents : pages).add(url.toString());
  }
  return { documents: [...documents].sort(), pages: [...pages].sort() };
}

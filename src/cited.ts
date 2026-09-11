import { hostAllowed, isDocument } from "@origin89/equipment-schema/documents";
import type { Manufacturer } from "@origin89/equipment-schema/manufacturer";
import type { Source } from "@origin89/equipment-schema/source";

/** Source URLs on a maker's own hosts: documents to offer, and pages to read for more. */
export interface Cited {
  documents: string[];
  pages: string[];
}

/**
 * What the records already cite on a maker's hosts. A person found these once and wrote them
 * down, so discovery offers them whether or not the site's sitemap leads to them: EPEVER's
 * XTRA-N G3 datasheet and manual are cited by a dialect record and were never in a plan (#48).
 * A source held only by path, with no URL, is not on any host and is left alone.
 */
export function citedFor(maker: Pick<Manufacturer, "domains">, sources: readonly Source[]): Cited {
  const documents = new Set<string>();
  const pages = new Set<string>();
  for (const source of sources) {
    if (!source.url) continue;
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

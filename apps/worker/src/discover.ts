import { hostAllowed } from "@origin89/equipment-schema/documents";
import { fetchText, isIndex, locations } from "./sitemap.ts";

/** Child sitemaps opened per index. An index of indexes is legal and is also how a crawl runs away. */
export const MAX_CHILD_SITEMAPS = 20;

/** What one host's sitemap gave: the host that answered, and every location it listed. */
interface SitemapListing {
  host: string;
  listed: string[];
}

const ownHost = (url: string, domains: readonly string[]): boolean => {
  try {
    return hostAllowed(new URL(url).hostname, domains);
  } catch {
    return false;
  }
};

/**
 * The sitemap of one domain, read from the bare host and then from `www.` when the bare host does
 * not answer. `pytesgroup.com` does not resolve and `longi.com` serves a certificate for another
 * name, while both answer at `www.`; a discovery that only knocked at the apex read nothing (#48).
 */
async function sitemapOf(
  domain: string,
  get: (url: string) => Promise<string>,
): Promise<SitemapListing | undefined> {
  const hosts = domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`];
  for (const host of hosts) {
    let root: string;
    try {
      root = await get(`https://${host}/sitemap.xml`);
    } catch {
      continue;
    }
    const listed = locations(root);
    if (!isIndex(root)) return { host, listed };
    const urls: string[] = [];
    for (const child of listed.slice(0, MAX_CHILD_SITEMAPS)) {
      try {
        urls.push(...locations(await get(child)));
      } catch {
        // A sitemap that will not load is one sitemap, not a reason to abandon the maker.
      }
    }
    return { host, listed: urls };
  }
  return undefined;
}

/**
 * The pages discovery will read for a maker: what its sitemaps list on its own hosts, and its home
 * page wherever a sitemap gives nothing to read.
 *
 * A sitemap that answers 200 with the HTML home page (`progressivedyn.com`, `southwire.com`,
 * `vosker.com`), or one whose every location is on a host the record does not claim
 * (`pulsetech.net` lists `pulsetech.com`), used to leave nothing to read at all, because the home
 * page was the fallback only for a sitemap that failed to load. A host that answers nothing gets
 * both its bare and its `www.` home page tried, since the pages are cheap and one of them is
 * usually the site.
 */
export async function discoverPages(
  domains: readonly string[],
  get: (url: string) => Promise<string> = fetchText,
): Promise<string[]> {
  const urls: string[] = [];
  for (const domain of domains) {
    const sitemap = await sitemapOf(domain, get);
    if (!sitemap) {
      urls.push(`https://${domain}/`);
      if (!domain.startsWith("www.")) urls.push(`https://www.${domain}/`);
      continue;
    }
    const own = sitemap.listed.filter((u) => ownHost(u, domains));
    if (own.length === 0) urls.push(`https://${sitemap.host}/`);
    else urls.push(...own);
  }
  return [...new Set(urls)];
}

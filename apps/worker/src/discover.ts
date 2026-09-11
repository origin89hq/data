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
 * The hosts to knock on for a domain: the domain itself, and `www.` in front of it when it is an
 * apex. `powerequipment.honda.com` and `solar.se.com` are sites in their own right, and a `www.`
 * in front of those is nobody's name.
 */
export function hostsToTry(domain: string): string[] {
  const labels = domain.split(".");
  // Two labels is an apex. Three is one when the middle label is a public second level such as
  // `co.uk` or `com.au`; the makers here are on plain TLDs, and a fuller list is a dependency
  // nothing yet needs.
  const apex =
    labels.length === 2 || (labels.length === 3 && PUBLIC_SECOND_LEVEL.has(labels[1] ?? ""));
  return apex && !domain.startsWith("www.") ? [domain, `www.${domain}`] : [domain];
}

/** Second-level labels under which a three-label name is still an apex: `maker.co.uk`, `maker.com.au`. */
const PUBLIC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "or", "ne"]);

/**
 * The sitemap of one domain, read from the bare host and then from `www.` when the bare host does
 * not answer. `pytesgroup.com` does not resolve and `longi.com` serves a certificate for another
 * name, while both answer at `www.`; a discovery that only knocked at the apex read nothing (#48).
 * A child sitemap is opened only on the maker's hosts: the index is the site's word, and the
 * crawl's boundary is the record's.
 */
async function sitemapOf(
  domain: string,
  domains: readonly string[],
  get: (url: string) => Promise<string>,
): Promise<SitemapListing | undefined> {
  for (const host of hostsToTry(domain)) {
    let root: string;
    try {
      root = await get(`https://${host}/sitemap.xml`);
    } catch {
      continue;
    }
    const listed = locations(root);
    if (!isIndex(root)) return { host, listed };
    const urls: string[] = [];
    const children = listed.filter((u) => ownHost(u, domains)).slice(0, MAX_CHILD_SITEMAPS);
    for (const child of children) {
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
    const sitemap = await sitemapOf(domain, domains, get);
    if (!sitemap) {
      urls.push(...hostsToTry(domain).map((host) => `https://${host}/`));
      continue;
    }
    const own = sitemap.listed.filter((u) => ownHost(u, domains));
    if (own.length === 0) urls.push(`https://${sitemap.host}/`);
    else urls.push(...own);
  }
  return [...new Set(urls)];
}

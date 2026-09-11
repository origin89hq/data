import {
  type Found,
  hostAllowed,
  isDocument,
  linkedDocuments,
} from "@origin89/equipment-schema/documents";
import { USER_AGENT } from "./feeds.ts";
import { isIndex, locations } from "./sitemap.ts";
import { judgeSpecPage, type SpecPageCandidate } from "./spec-table.ts";

/** Child sitemaps opened per index. An index of indexes is legal and is also how a crawl runs away. */
export const MAX_CHILD_SITEMAPS = 20;

/**
 * One answer from a site. `status` 0 is a host that did not answer at all; `url` is where the
 * answer came from, after redirects, which is how a site that moved shows itself.
 */
export interface Fetched {
  status: number;
  url: string;
  text: string;
  /** The media type the host declared, when it did. A document's body is never read here. */
  contentType?: string;
  /** The host sent it as a file to save rather than a page to show. */
  attachment?: true;
}

const mediaType = (answer: Fetched): string | undefined =>
  answer.contentType?.split(";")[0]?.trim().toLowerCase();

/** Media types that are the documents this crawl archives, for an address that does not say. */
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
]);

/** Whether an answer is a page to read: HTML or XML, and nothing the host marked as a file. */
export function isPage(answer: Fetched): boolean {
  if (isDocument(answer.url) || answer.attachment) return false;
  const type = mediaType(answer);
  return (
    type === undefined ||
    /^(text\/html|text\/xml|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml))$/.test(type)
  );
}

/**
 * Whether an answer is one of the documents this crawl offers, by its address, by the host
 * sending it as a file, or by a media type on the archive's list. An image or a script served at
 * an extensionless address is neither a page nor a document.
 */
export function isDocumentAnswer(answer: Fetched): boolean {
  if (isDocument(answer.url) || answer.attachment) return true;
  const type = mediaType(answer);
  return type !== undefined && DOCUMENT_TYPES.has(type);
}

export type Get = (url: string) => Promise<Fetched>;

/** A page or sitemap, read the way a browser would follow it, and never thrown. */
export async function fetchPage(url: string): Promise<Fetched> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml",
      },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") ?? undefined;
    const attachment = /^\s*attachment\b/i.test(response.headers.get("content-disposition") ?? "");
    const answer: Fetched = {
      status: response.status,
      url: response.url || url,
      text: "",
      ...(contentType ? { contentType } : {}),
      ...(attachment ? { attachment: true as const } : {}),
    };
    // A page that turns out to be a PDF is offered, not read: nothing is downloaded before a
    // person approves it, and a manual is not HTML to parse.
    if (response.ok && isPage(answer)) answer.text = await response.text();
    else await response.body?.cancel();
    return answer;
  } catch {
    return { status: 0, url, text: "" };
  }
}

/**
 * What one domain's sitemaps gave. Written into the plan, so a plan that offers nothing can be
 * read back for why: a host that refused, a host that did not answer, a sitemap that was the home
 * page, or one that listed a site the record does not claim.
 */
export interface HostSeen {
  domain: string;
  /** The host that answered, or the last one asked when none did. */
  host: string;
  /** The sitemap's HTTP status at that host; 0 when the host did not answer. */
  status: number;
  /** `html` is a 200 that was not a sitemap at all, which is what some sites serve at the address. */
  sitemap: "index" | "urlset" | "html" | "none";
  /** Locations listed, and how many of them are on the maker's hosts. */
  listed: number;
  own: number;
  /** Every sitemap request made for this domain, the `www.` try and each child included, and how many of them were refused or unanswered. */
  requests: number;
  refused: number;
  silent: number;
  /** Child sitemaps of an index that could not be read, or were not opened because the index had more than the cap, so a thin listing is not mistaken for a thin site. */
  childrenFailed: number;
  childrenSkipped: number;
  /** Hosts outside the record that any of those requests landed on. */
  redirectedTo: string[];
}

export interface Discovery {
  pages: string[];
  hosts: HostSeen[];
}

const ok = (answer: Fetched): boolean => answer.status >= 200 && answer.status < 300;

/** Whether a body is a sitemap at all, rather than a page served where one was asked for. */
const isSitemap = (xml: string): boolean => isIndex(xml) || /<urlset[\s>]/i.test(xml);

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

const ownHost = (url: string, domains: readonly string[]): boolean => {
  const host = hostOf(url);
  return host !== undefined && hostAllowed(host, domains);
};

/** The host an answer landed on when it is not one of the maker's. */
const strayed = (answer: Fetched, domains: readonly string[]): string | undefined => {
  const landed = hostOf(answer.url);
  return landed !== undefined && !hostAllowed(landed, domains) ? landed : undefined;
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

/** One request's outcome, folded into the host's tallies. */
function tally(seen: HostSeen, answer: Fetched, domains: readonly string[]): void {
  seen.requests += 1;
  if (answer.status === 403) seen.refused += 1;
  if (answer.status === 0) seen.silent += 1;
  const away = strayed(answer, domains);
  if (away && !seen.redirectedTo.includes(away)) seen.redirectedTo.push(away);
}

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
  get: Get,
): Promise<{ seen: HostSeen; listed: string[] }> {
  const hosts = hostsToTry(domain);
  const seen: HostSeen = {
    domain,
    host: hosts[0],
    status: 0,
    sitemap: "none",
    listed: 0,
    own: 0,
    requests: 0,
    refused: 0,
    silent: 0,
    childrenFailed: 0,
    childrenSkipped: 0,
    redirectedTo: [],
  };
  for (const host of hosts) {
    const answer = await get(`https://${host}/sitemap.xml`);
    tally(seen, answer, domains);
    seen.host = host;
    seen.status = answer.status;
    if (!ok(answer)) continue;
    const root = answer.text;
    let listed = locations(root);
    if (isIndex(root)) {
      seen.sitemap = "index";
      const urls: string[] = [];
      const own = listed.filter((u) => ownHost(u, domains));
      const children = own.slice(0, MAX_CHILD_SITEMAPS);
      seen.childrenSkipped = own.length - children.length;
      for (const child of children) {
        const page = await get(child);
        tally(seen, page, domains);
        // A sitemap that will not load is one sitemap, not a reason to abandon the maker. One that
        // answers with a consent page or a bot challenge is not a sitemap either.
        if (ok(page) && isSitemap(page.text)) urls.push(...locations(page.text));
        else seen.childrenFailed += 1;
      }
      listed = urls;
    } else seen.sitemap = isSitemap(root) ? "urlset" : "html";
    seen.listed = listed.length;
    seen.own = listed.filter((u) => ownHost(u, domains)).length;
    return { seen, listed };
  }
  return { seen, listed: [] };
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
  get: Get = fetchPage,
): Promise<Discovery> {
  const urls: string[] = [];
  const hosts: HostSeen[] = [];
  for (const domain of domains) {
    const { seen, listed } = await sitemapOf(domain, domains, get);
    hosts.push(seen);
    const own = listed.filter((u) => ownHost(u, domains));
    if (own.length > 0) urls.push(...own);
    else if (seen.sitemap !== "none") urls.push(`https://${seen.host}/`);
    else urls.push(...hostsToTry(domain).map((host) => `https://${host}/`));
  }
  return { pages: [...new Set(urls)], hosts };
}

/** What one batch of pages gave, in numbers a plan can carry and a person can read. */
export interface PagesRead {
  links: Found[];
  tables: SpecPageCandidate[];
  read: number;
  /** The pages asked for that answered with a page, as they were asked for. */
  opened: string[];
  /** Pages that gave no HTML, by HTTP status; "0" is a host that did not answer. */
  failed: Record<string, number>;
  /** Documents linked on hosts the record does not claim: the distinct addresses, by host. */
  foreign: Record<string, string[]>;
  /** Hosts outside the record that pages redirected to. */
  redirectedTo: string[];
}

const count = (into: Record<string, number>, key: string): void => {
  into[key] = (into[key] ?? 0) + 1;
};

/** Read pages for their document links, and say what each page that gave none answered instead. */
export async function readPages(
  pages: readonly string[],
  domains: readonly string[],
  get: Get = fetchPage,
): Promise<PagesRead> {
  const out: PagesRead = {
    links: [],
    tables: [],
    opened: [],
    read: 0,
    failed: {},
    foreign: {},
    redirectedTo: [],
  };
  const strayedTo = new Set<string>();
  for (const page of pages) {
    const answer = await get(page);
    const away = strayed(answer, domains);
    if (away) strayedTo.add(away);
    if (!ok(answer)) {
      // One page that will not load costs its own links and nothing else.
      count(out.failed, String(answer.status));
      continue;
    }
    if (!isPage(answer)) {
      // A page that answered with a document, by its address or its media type, is that document:
      // offered where it landed, with the page it was asked for as where it was found. Anything
      // else that is not a page, an image or a script, is counted and left alone.
      const host = hostOf(answer.url);
      if (host === undefined) continue;
      if (!isDocumentAnswer(answer)) {
        count(out.failed, `not a page (${mediaType(answer) ?? "unknown type"})`);
        continue;
      }
      if (hostAllowed(host, domains)) out.links.push({ url: answer.url, host, foundOn: page });
      else {
        const urls = out.foreign[host] ?? [];
        if (!urls.includes(answer.url)) urls.push(answer.url);
        out.foreign[host] = urls;
      }
      continue;
    }
    out.read += 1;
    out.opened.push(page);
    // Links resolve against where the page actually is, which after a redirect is not where it was asked for.
    for (const doc of linkedDocuments(answer.text, answer.url)) {
      if (hostAllowed(doc.host, domains)) out.links.push(doc);
      else {
        // A CDN manual linked from a footer on twenty pages is one document, not twenty.
        const urls = out.foreign[doc.host] ?? [];
        if (!urls.includes(doc.url)) urls.push(doc.url);
        out.foreign[doc.host] = urls;
      }
    }
    // The page is already here for its links. Judging it as a specification table too costs
    // nothing and is how the feed list stops being hand-typed.
    const candidate = judgeSpecPage(page, answer.text);
    if (candidate) out.tables.push(candidate);
  }
  out.redirectedTo = [...strayedTo].sort();
  return out;
}

/** Everything discovery saw, written beside the plan so an empty one can be explained. */
export interface DiscoverySeen {
  hosts: HostSeen[];
  /** Pages the site listed on its own hosts, how many were read, and what the rest answered. A read below the listing is a sample. */
  pages: { listed?: number; read: number; failed: Record<string, number> };
  /** Distinct documents linked on hosts the record does not claim, by host. */
  foreignDocumentHosts: Record<string, number>;
  redirectedTo: string[];
}

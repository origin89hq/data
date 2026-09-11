import {
  baseHref,
  decodeEntities,
  type Found,
  hostAllowed,
  isDocument,
  linkedDocuments,
  withoutBase,
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
  /** The body was longer than a page is read for, and the rest was left unread. */
  truncated?: true;
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

/** What a page request asks for. */
export const ACCEPT_PAGE = "text/html,application/xhtml+xml,application/xml";

/**
 * How much of a page is read. A page is read for its links and its tables, and a couple of
 * mebibytes holds any page worth reading; an endpoint that answers with no media type at all,
 * which is read as a page for want of a better guess, cannot pull more than this before a person
 * has approved anything.
 */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** The body up to `limit` bytes, cancelling the rest, and whether anything was left unread. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= limit) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const joined = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, joined.length - at);
    joined.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= joined.length) break;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

/** A page or sitemap, read the way a browser would follow it, and never thrown. */
export async function fetchPage(
  url: string,
  accept: string = ACCEPT_PAGE,
  /** Whether a page's body is wanted at all; a probe wants only the headers. */
  readBody = true,
): Promise<Fetched> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept },
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
    // A sitemap served as plain text is still a sitemap to read, not a file to offer.
    const sitemapAsText =
      mediaType(answer) === "text/plain" && /sitemap|\.xml(?:$|[?#])/i.test(url);
    if (readBody && response.ok && (isPage(answer) || sitemapAsText)) {
      const body = await readBounded(response, MAX_PAGE_BYTES);
      answer.text = body.text;
      if (body.truncated) answer.truncated = true;
    } else await response.body?.cancel();
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
  /** Of those, where the sitemap request itself landed: the sign of a site that moved. */
  rootRedirectedTo: string[];
  /** Hosts outside the record that the sitemap lists pages on, most listed first, three at most, and how many more there were. */
  listedElsewhere: string[];
  listedElsewhereMore: number;
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
function tally(seen: HostSeen, answer: Fetched, domains: readonly string[], root = false): void {
  seen.requests += 1;
  if (answer.status === 403) seen.refused += 1;
  if (answer.status === 0) seen.silent += 1;
  const away = strayed(answer, domains);
  if (away && !seen.redirectedTo.includes(away)) seen.redirectedTo.push(away);
  if (away && root && !seen.rootRedirectedTo.includes(away)) seen.rootRedirectedTo.push(away);
}

/** The hosts a listing points at that are not the maker's, most listed first, three at most. */
function elsewhere(
  listed: readonly string[],
  domains: readonly string[],
): { hosts: string[]; more: number } {
  const counts = new Map<string, number>();
  for (const url of listed) {
    const host = hostOf(url);
    if (host === undefined || hostAllowed(host, domains)) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const hosts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([host]) => host);
  return { hosts, more: counts.size - hosts.length };
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
    rootRedirectedTo: [],
    listedElsewhere: [],
    listedElsewhereMore: 0,
  };
  for (const host of hosts) {
    const answer = await get(`https://${host}/sitemap.xml`);
    tally(seen, answer, domains, true);
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
      // Children beyond the cap, and children on hosts the record does not claim, which the
      // crawl will not cross to: both are sitemaps this run did not open.
      seen.childrenSkipped = own.length - children.length + (listed.length - own.length);
      for (const child of children) {
        const page = await get(child);
        tally(seen, page, domains);
        // A sitemap that will not load is one sitemap, not a reason to abandon the maker. One that
        // answers with a consent page or a bot challenge is not a sitemap either.
        if (ok(page) && isSitemap(page.text) && !isIndex(page.text))
          urls.push(...locations(page.text));
        // An index inside the index is a level this crawl does not open; its sitemaps are counted
        // as unopened rather than read as pages.
        else if (ok(page) && isIndex(page.text))
          seen.childrenSkipped += locations(page.text).length;
        else seen.childrenFailed += 1;
      }
      listed = urls;
    } else seen.sitemap = isSitemap(root) ? "urlset" : "html";
    seen.listed = listed.length;
    seen.own = listed.filter((u) => ownHost(u, domains)).length;
    const away = elsewhere(listed, domains);
    seen.listedElsewhere = away.hosts;
    seen.listedElsewhereMore = away.more;
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

/** An `href`, quoted either way or not at all, as HTML allows. */
const HREF = /(?<![-\w])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
/** The elements a page navigates with. */
const NAV = /<(?:a|area)\b[^>]*>/gi;

/** Files a page links that are neither pages to read nor documents to keep. */
const ASSET =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|json|webmanifest|xml|xsl|rss|atom|woff2?|ttf|otf|eot|wasm|mp4|webm|mp3|ogg|wav|avi|mov)$/i;

/**
 * The pages a page links on the maker's own hosts, absolute and deduplicated: the next hop.
 * EPEVER's sitemap is stale and does not list the XTRA-N G3 page, while its category pages link
 * it; a discovery that never left the sitemap could not reach a current product (#48).
 */
export function pageLinks(html: string, pageUrl: string, domains: readonly string[]): string[] {
  const out = new Set<string>();
  // Relative links resolve as a browser would, against the page's `<base href>` when it has one.
  const base = baseHref(html, pageUrl);
  // Only what a person could click: a `<link rel="alternate">` in the head is not navigation.
  for (const tag of withoutBase(html).match(NAV) ?? [])
    for (const match of tag.matchAll(HREF)) {
      let url: URL;
      try {
        url = new URL(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ""), base);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      url.hash = "";
      const href = url.toString();
      if (isDocument(href) || ASSET.test(url.pathname) || !hostAllowed(url.hostname, domains))
        continue;
      out.add(href);
    }
  return [...out];
}

/**
 * Links one batch of pages may hand back. A step's result is capped by Workflows at a mebibyte,
 * and twenty navigation-heavy pages can link far more than a run will ever follow, so the frontier
 * is cut here rather than failing the step that carries it.
 */
export const MAX_LINKS_PER_BATCH = 2000;
/** And bounded in bytes as well, since generated filter addresses can run long. */
export const MAX_FRONTIER_BYTES = 512 * 1024;
/** The whole serialized result stays under this, well inside the mebibyte a step may return. */
export const MAX_RESULT_BYTES = 768 * 1024;

/** Paths a maker keeps its documents behind, ahead of its blog, its careers page and its cart. */
const WORTH_FIRST =
  /product|download|support|manual|datasheet|data-sheet|resource|spec|document|literature|catalog/i;

/**
 * The order to follow links in when the budget will not cover them all: pages whose path says
 * product or download first, everything else after, each in the order they were found.
 */
export function hopOrder(candidates: readonly string[]): string[] {
  const first: string[] = [];
  const rest: string[] = [];
  for (const url of candidates) {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      // A candidate that is not a URL sorts last and fails to load like any other.
    }
    (WORTH_FIRST.test(path) ? first : rest).push(url);
  }
  return [...first, ...rest];
}

/**
 * The next pages to follow: up to `limit` entries of the ranked frontier from `from`, skipping
 * any that a page read since has landed on, and where the walk stopped so the next batch starts
 * there. A frontier drawn on this way replenishes itself: a slot a redirect would have wasted
 * goes to the candidate after it.
 */
export function nextHop(
  frontier: readonly string[],
  from: number,
  skip: ReadonlySet<string>,
  limit: number,
): { slice: string[]; cursor: number } {
  const slice: string[] = [];
  let cursor = from;
  while (cursor < frontier.length && slice.length < limit) {
    const candidate = frontier[cursor];
    cursor += 1;
    if (candidate !== undefined && !skip.has(candidate)) slice.push(candidate);
  }
  return { slice, cursor };
}

/** What one batch of pages gave, in numbers a plan can carry and a person can read. */
export interface PagesRead {
  links: Found[];
  tables: SpecPageCandidate[];
  /** Finds cut to keep the result under the step cap: documents and specification pages. */
  documentsDropped: number;
  tablesDropped: number;
  /** Pages these pages link on the maker's hosts, for the hop after this one, product and download pages first and bounded. */
  pages: string[];
  /** Links found beyond that bound and left behind. */
  linksDropped: number;
  /** Where each page read actually was, after redirects, so a link back to it is not a page to follow. */
  landed: string[];
  /** Pages actually asked for: one in the batch that an earlier page had already landed on is skipped. */
  attempted: number;
  read: number;
  /** The pages asked for that answered with a page, as they were asked for. */
  opened: string[];
  /** The pages asked for that answered with a document themselves, as they were asked for. */
  answered: string[];
  /** Pages that gave no HTML, by HTTP status; "0" is a host that did not answer. */
  failed: Record<string, number>;
  /** Documents linked on hosts the record does not claim: the distinct addresses, by host. */
  foreign: Record<string, string[]>;
  /** Foreign addresses cut from those lists to keep the result under the step cap. */
  foreignDropped: number;
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
  /** Addresses earlier batches landed on: a listed page among them is a page already read. */
  skip: ReadonlySet<string> = new Set(),
): Promise<PagesRead> {
  const out: PagesRead = {
    links: [],
    tables: [],
    documentsDropped: 0,
    tablesDropped: 0,
    pages: [],
    linksDropped: 0,
    landed: [],
    attempted: 0,
    opened: [],
    answered: [],
    read: 0,
    failed: {},
    foreign: {},
    foreignDropped: 0,
    redirectedTo: [],
  };
  const strayedTo = new Set<string>();
  const linked = new Set<string>();
  const collected: string[] = [];
  for (const page of pages) {
    // Two candidates in one batch can be one page, when the first redirects to the second.
    if (out.landed.includes(page) || skip.has(page)) continue;
    out.attempted += 1;
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
      out.answered.push(page);
      if (hostAllowed(host, domains)) out.links.push({ url: answer.url, host, foundOn: page });
      else {
        const urls = out.foreign[host] ?? [];
        if (!urls.includes(answer.url)) urls.push(answer.url);
        out.foreign[host] = urls;
      }
      continue;
    }
    out.read += 1;
    out.landed.push(answer.url);
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
    // A page's link to itself, canonical or otherwise, is not a page to follow.
    for (const link of pageLinks(answer.text, answer.url, domains))
      if (link !== answer.url && link !== page && !linked.has(link)) {
        linked.add(link);
        collected.push(link);
      }
    // The page is already here for its links. Judging it as a specification table too costs
    // nothing and is how the feed list stops being hand-typed.
    const candidate = judgeSpecPage(page, answer.text);
    if (candidate) out.tables.push(candidate);
  }
  out.redirectedTo = [...strayedTo].sort();
  // The frontier handed back is bounded, and bounded after ranking, so a batch that links two
  // thousand blog posts before its product pages still hands the product pages back.
  const ranked = hopOrder(collected);
  let bytes = 0;
  out.pages = [];
  for (const link of ranked) {
    if (out.pages.length >= MAX_LINKS_PER_BATCH || bytes + link.length > MAX_FRONTIER_BYTES) break;
    out.pages.push(link);
    bytes += link.length;
  }
  out.linksDropped = ranked.length - out.pages.length;
  bound(out);
  return out;
}

/**
 * Keep the serialized result under the step-result cap: first the frontier gives way, then the
 * foreign document lists, since both are counts a person reads and neither is lost entirely.
 */
function bound(out: PagesRead): void {
  // Measured as the bytes a step result is, not as code units: a table of model names in
  // another script is longer on the wire than in a string.
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  while (size() > MAX_RESULT_BYTES && out.pages.length > 0) {
    const keep = Math.floor(out.pages.length * 0.8);
    out.linksDropped += out.pages.length - keep;
    out.pages = out.pages.slice(0, keep);
  }
  // Foreign lists shrink in rounds, twenty a host and then fewer, until the result fits or the
  // lists are gone; the counts a person reads survive in `foreignDropped`.
  for (const cap of [20, 10, 5, 2, 1, 0]) {
    if (size() <= MAX_RESULT_BYTES) break;
    for (const host of Object.keys(out.foreign)) {
      const urls = out.foreign[host] ?? [];
      out.foreignDropped += Math.max(0, urls.length - cap);
      out.foreign[host] = urls.slice(0, cap);
    }
  }
  // Last of all the finds themselves, counted so a plan built from a cut batch says so.
  while (size() > MAX_RESULT_BYTES && out.tables.length > 0) {
    const keep = Math.floor(out.tables.length * 0.8);
    out.tablesDropped += out.tables.length - keep;
    out.tables = out.tables.slice(0, keep);
  }
  while (size() > MAX_RESULT_BYTES && out.links.length > 0) {
    const keep = Math.floor(out.links.length * 0.8);
    out.documentsDropped += out.links.length - keep;
    out.links = out.links.slice(0, keep);
  }
}

/** What the records cite on a maker's hosts, as bundled with the maker list. */
export interface Cited {
  documents: readonly string[];
  pages: readonly string[];
}

/**
 * The pages to read: what the records cite first, since a person chose those, then the site's
 * own list sampled into what is left of the budget. A cited page on a host the run may not reach
 * is left out, as is one already listed.
 */
export function seedPages(
  cited: Cited,
  discovered: readonly string[],
  domains: readonly string[],
  budget: number,
  pick: (urls: string[], limit: number) => string[],
): string[] {
  const first = [...new Set(cited.pages.filter((u) => ownHost(u, domains)))].slice(
    0,
    Math.max(0, budget),
  );
  // `sample` reads a limit of zero as no limit at all, so a budget the citations have used up
  // ends here rather than in the whole sitemap.
  const remaining = budget - first.length;
  if (remaining <= 0) return first;
  return [
    ...first,
    ...pick(
      discovered.filter((u) => !first.includes(u)),
      remaining,
    ),
  ];
}

/**
 * The documents found, with the ones the records cite added after them. A cited document the
 * site also led to is one document, found on its page and marked as cited too; one the site did
 * not lead to is offered anyway, marked as cited so the approver knows where it came from.
 */
export function withCited(
  found: readonly Found[],
  cited: Cited,
  domains: readonly string[],
  /** Cited pages that answered with a document rather than with HTML to read. */
  answered: ReadonlySet<string> = new Set(),
): Found[] {
  // Cited by address, or found by asking for a cited page that answered with the document
  // itself. A link on a cited page that answered with HTML is the page's find, not the citation.
  const seed = (f: Found) => f.foundOn !== undefined && answered.has(f.foundOn);
  const out: Found[] = found.map((f) =>
    cited.documents.includes(f.url) || seed(f) ? { ...f, cited: true as const } : f,
  );
  for (const url of cited.documents) {
    const host = hostOf(url);
    if (host === undefined || !hostAllowed(host, domains)) continue;
    if (out.some((f) => f.url === url)) continue;
    out.push({ url, host, cited: true });
  }
  return out;
}

/** Everything discovery saw, written beside the plan so an empty one can be explained. */
export interface DiscoverySeen {
  hosts: HostSeen[];
  /** Pages the site listed on its own hosts, how many were read in all, how many of those by following links, and what the rest answered. A read below the listing is a sample. */
  pages: {
    listed?: number;
    read: number;
    followed?: number;
    /** Links the batches found beyond what they may hand back, and so never followed. */
    linksDropped?: number;
    /** Candidates handed back that the page budget did not reach. */
    unfollowed?: number;
    /** Finds cut from batches to keep their results under the step cap. */
    documentsDropped?: number;
    tablesDropped?: number;
    failed: Record<string, number>;
  };
  /** What the records cite on the maker's hosts: documents offered, and pages read as seeds. */
  cited?: { documents: number; pages: number };
  /** Distinct documents linked on hosts the record does not claim, by host, and how many more were seen than could be carried. */
  foreignDocumentHosts: Record<string, number>;
  foreignDocumentsDropped?: number;
  redirectedTo: string[];
}

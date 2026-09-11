import { decodeHTMLStrict } from "entities";
import { z } from "zod";

/** What a maker's site publishes that is worth archiving. A page is read for links; only these are stored. */
export const DOCUMENT_EXTENSIONS = [".pdf", ".zip", ".xlsx", ".csv", ".txt"] as const;

/** One document a discovery pass found, before anything is fetched. */
export const Found = z
  .object({
    url: z.string().url(),
    /** The host it lives on, which must be one the maker's record claims. */
    host: z.string().min(1),
    /** Bytes, when the host answered a HEAD. Absent means unknown, never zero. */
    bytes: z.number().int().nonnegative().optional(),
    /** The page whose link this was, so a document can be traced to where the maker offers it. */
    foundOn: z.string().url().optional(),
    /** Offered because a record cites it, whether or not the site led discovery to it. */
    cited: z.literal(true).optional(),
  })
  .strict();
export type Found = z.infer<typeof Found>;

/**
 * What a person is shown before a download starts, and what they approve. The scale is the point:
 * a maker with four hundred documents and a gigabyte behind them is a decision, not a default.
 */
export const CrawlPlan = z
  .object({
    manufacturer: z.string().min(1),
    /** Empty when nothing was found, which is an answer about the maker's site and not a failure. */
    hosts: z.array(z.string()),
    documents: z.number().int().nonnegative(),
    /** Sum of the sizes that were reported. Undercounts when a host answers no HEAD, and says so. */
    knownBytes: z.number().int().nonnegative(),
    sizesUnknown: z.number().int().nonnegative(),
    examples: z.array(z.string()).default([]),
  })
  .strict();
export type CrawlPlan = z.infer<typeof CrawlPlan>;

/**
 * The go-ahead. It is external input to a running instance, so it is parsed rather than trusted,
 * and it names a person: an unattributed approval is not one.
 */
export const CrawlApproval = z
  .object({
    approved: z.boolean(),
    approvedBy: z.string().min(1),
    /** Hosts the approver is willing to have fetched. A host not here is not fetched, even if discovery found it. */
    hosts: z.array(z.string().min(1)).default([]),
    /** Stop after this many documents, when the approver wants a sample rather than the site. */
    limit: z.number().int().positive().optional(),
    note: z.string().optional(),
  })
  .strict();
export type CrawlApproval = z.infer<typeof CrawlApproval>;

/** Whether a URL points at something worth archiving rather than another page to read. */
export function isDocument(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return DOCUMENT_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * Whether a host belongs to a maker that claims it. A suffix match on a dot boundary, so
 * `files.victronenergy.com` counts for `victronenergy.com` and `notvictronenergy.com` does not.
 */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, "");
    return h === domain || h.endsWith(`.${domain}`);
  });
}

/** An `href`, quoted either way or not at all, as HTML allows. */
/** `data-href` and the like are not links; a hyphen or a word character in front rules them out. */
const HREF = /(?<![-\w])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const BASE = /<base\b[^>]*(?<![-\w])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))[^>]*>/i;

/**
 * The address a page's relative links resolve against: its first `<base href>` when it has one,
 * as a browser does, and otherwise the page's own address. The tag itself is no link.
 */
export function baseHref(html: string, pageUrl: string): string {
  const found = BASE.exec(withoutText(html));
  const base = found?.[1] ?? found?.[2] ?? found?.[3];
  if (!base) return pageUrl;
  try {
    return new URL(decodeEntities(base), pageUrl).toString();
  } catch {
    return pageUrl;
  }
}

/**
 * The page's markup with everything that is not link-bearing HTML removed: `<base>` tags, whose
 * `href` is not a link, and scripts, styles, templates and comments, where an `href` is text.
 */
export function withoutBase(html: string): string {
  return withoutText(html).replace(/<base\b[^>]*>/gi, "");
}

/** The page's markup with scripts, styles, templates and comments removed: a tag in those is text, not markup. */
function withoutText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, "");
}

/**
 * An href is HTML, so its entities are markup and not part of the address. Victron publishes
 * "TERMS-&amp;-CONDITIONS-OF-SALE.pdf", and fetching that literally returns nothing.
 */
export function decodeEntities(value: string): string {
  // Strict, meaning the semicolon is required. The forgiving form reads "?a=1&param=2" as
  // "?a=1\u00b6m=2", because "&para" is a legacy entity a browser accepts without one — which would
  // rewrite the query string of any link whose parameter happens to start with a named entity.
  return decodeHTMLStrict(value);
}

/**
 * Every document a page links, absolute and deduplicated, on whatever host. A maker's own page
 * linking its manual on a shop's CDN is still a fact about that page, and discovery counts those
 * so a plan can say where the documents went rather than that there were none (#48).
 */
export function linkedDocuments(html: string, pageUrl: string): Found[] {
  const found = new Map<string, Found>();
  const base = baseHref(html, pageUrl);
  for (const match of withoutBase(html).matchAll(HREF)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ""), base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const href = url.toString();
    if (!isDocument(href)) continue;
    if (!found.has(href)) found.set(href, { url: href, host: url.hostname, foundOn: pageUrl });
  }
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/** Every link on a page, absolute, deduplicated, and only on hosts the maker claims. */
export function documentLinks(html: string, pageUrl: string, domains: readonly string[]): Found[] {
  return linkedDocuments(html, pageUrl).filter((f) => hostAllowed(f.host, domains));
}

/** Summarise a discovery for the person who has to approve it. */
export function planFor(manufacturer: string, found: Found[]): CrawlPlan {
  const sized = found.filter((f) => f.bytes !== undefined);
  return CrawlPlan.parse({
    manufacturer,
    hosts: [...new Set(found.map((f) => f.host))].sort(),
    documents: found.length,
    knownBytes: sized.reduce((n, f) => n + (f.bytes ?? 0), 0),
    sizesUnknown: found.length - sized.length,
    examples: found.slice(0, 8).map((f) => f.url),
  });
}

/** What the approval actually permits, which is never more than what discovery found. */
export function permitted(found: Found[], approval: CrawlApproval): Found[] {
  if (!approval.approved) return [];
  const hosts = approval.hosts.length ? approval.hosts : [...new Set(found.map((f) => f.host))];
  const allowed = found.filter((f) => hostAllowed(f.host, hosts));
  return approval.limit ? allowed.slice(0, approval.limit) : allowed;
}

/**
 * Which language a document is written in, when its own file name says so.
 *
 * Sol-Ark publishes the 8K manual twice, as `..._UserManual_v1.0_ES_...pdf` and
 * `...-8K-2P-N-EN-Manual...pdf`, and reading both gave that inverter a nominal voltage of 48 V
 * under "Nominal system voltage" and again under "Voltaje nominal". The figures were right and the
 * dataset still counted the product twice, which is the shape of the whole problem: a translation
 * is the same specification said again, so it is not a second source, and converting it is a
 * reading paid for twice.
 */
/** The languages seen in these makers' file names. Deliberately short: a guess here drops a document. */
const LANGUAGES = ["es", "fr", "pt", "it", "nl", "zh", "ja", "ko", "ru", "pl", "sv", "tr"] as const;

/** Delimited, so "Manual-ES-1.pdf" matches and "GENESIS.pdf" does not. */
const tokenIn = (name: string, token: string): boolean =>
  new RegExp(`(?:^|[-_. ])${token}(?:[-_][A-Za-z]{2})?(?:$|[-_. ])`, "i").test(name);

/**
 * The language a document's file name declares, or undefined when it declares none. A file naming
 * English as well — `GB10_Userguide_EN_ES_10.20.2022.pdf` is one bilingual guide — is not a
 * translation of anything, so it declares nothing.
 */
export function declaredLanguage(url: string): string | undefined {
  let name: string;
  try {
    name = new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return undefined;
  }
  name = name.replace(/\.[A-Za-z0-9]+$/, "");
  if (tokenIn(name, "en")) return undefined;
  return LANGUAGES.find((language) => tokenIn(name, language));
}

/**
 * The documents worth reading, with a translation dropped when the maker also publishes something
 * not marked as one. A maker who publishes only in French keeps every document it has: the choice
 * is between one language and two, never between a language and nothing.
 */
export function withoutTranslations<T extends { url: string }>(
  documents: T[],
): { keep: T[]; dropped: { url: string; language: string }[] } {
  const translated = documents.map((document) => ({
    document,
    language: declaredLanguage(document.url),
  }));
  const anyUntranslated = translated.some((row) => row.language === undefined);
  if (!anyUntranslated) return { keep: documents, dropped: [] };
  return {
    keep: translated.filter((row) => row.language === undefined).map((row) => row.document),
    dropped: translated
      .filter((row) => row.language !== undefined)
      .map((row) => ({ url: row.document.url, language: row.language as string })),
  };
}

/**
 * The event a person sends to release a maker's download.
 *
 * It lives beside the approval it carries rather than inside the workflow that waits for it: the
 * router needs the name to send one, and importing a `WorkflowEntrypoint` for a string pulls the
 * Cloudflare runtime into everything that touches the routes, tests included.
 */
export const APPROVAL_EVENT = "crawl-approved";

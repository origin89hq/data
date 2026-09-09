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
    hosts: z.array(z.string()).min(1),
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

const HREF = /\bhref\s*=\s*["']([^"']+)["']/gi;

/**
 * An href is HTML, so its entities are markup and not part of the address. Victron publishes
 * "TERMS-&amp;-CONDITIONS-OF-SALE.pdf", and fetching that literally returns nothing.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|#39));/g, (whole, dec: string, hex: string, name: string) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }[name] ?? whole;
    });
}

/** Every link on a page, absolute, deduplicated, and only on hosts the maker claims. */
export function documentLinks(html: string, pageUrl: string, domains: readonly string[]): Found[] {
  const found = new Map<string, Found>();
  for (const match of html.matchAll(HREF)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1]), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const href = url.toString();
    if (!isDocument(href) || !hostAllowed(url.hostname, domains)) continue;
    if (!found.has(href)) found.set(href, { url: href, host: url.hostname });
  }
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
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

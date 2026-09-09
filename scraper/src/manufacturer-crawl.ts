import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CrawlApproval, documentLinks, hostAllowed, permitted, planFor, type Found } from "./documents.ts";
import { fetchText, isIndex, locations, sample } from "./sitemap.ts";
import { judgeSpecPage, type SpecPageCandidate } from "./spec-table.ts";
import { USER_AGENT } from "./feeds.ts";

export interface ManufacturerCrawlParams {
  manufacturerId: string;
  /** Hosts this maker claims, from its record. The instance knows no others and can reach no others. */
  domains: string[];
  checkedAt: string;
  /** How many pages of the site to read for links. Discovery is cheap; downloading is not. */
  pageLimit?: number;
}

/** The event a person sends to let the download start. Nothing happens without it. */
export const APPROVAL_EVENT = "crawl-approved";

/** How long an instance waits for a person. Long enough to be answered on a working day, short enough not to linger. */
export const APPROVAL_TIMEOUT = "3 days";

/** Pages read per step during discovery, and documents fetched per step afterwards. */
export const DISCOVER_BATCH = 20;
export const FETCH_BATCH = 10;

/**
 * Hop two: a maker's own documents. The instance discovers what it *would* fetch, writes the
 * plan, then stops and waits for a person to approve it.
 *
 * The failure this prevents is a crawl that downloads a gigabyte off somebody's site because a
 * brand resolved at two in the morning. A timeout ends the instance without fetching anything:
 * silence is a refusal, never a go-ahead.
 */
export class ManufacturerCrawl extends WorkflowEntrypoint<Env, ManufacturerCrawlParams> {
  async run(event: WorkflowEvent<ManufacturerCrawlParams>, step: WorkflowStep) {
    const { manufacturerId, domains, checkedAt, pageLimit } = event.payload;
    if (domains.length === 0) throw new Error(`${manufacturerId}: no domains, so there is nothing this instance may reach`);
    const prefix = `documents/${manufacturerId}/${checkedAt}`;

    const pages = await step.do("discover pages", { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "3 minutes" }, async () => {
      const urls: string[] = [];
      for (const domain of domains) {
        try {
          const root = await fetchText(`https://${domain}/sitemap.xml`);
          const listed = locations(root);
          if (isIndex(root)) {
            for (const child of listed.slice(0, 20)) {
              try {
                urls.push(...locations(await fetchText(child)));
              } catch {
                // A sitemap that will not load is one sitemap, not a reason to abandon the maker.
              }
            }
          } else urls.push(...listed);
        } catch {
          urls.push(`https://${domain}/`);
        }
      }
      const own = [...new Set(urls)].filter((u) => {
        try {
          return hostAllowed(new URL(u).hostname, domains);
        } catch {
          return false;
        }
      });
      return sample(own, pageLimit ?? 200);
    });

    const found: Found[] = [];
    const specPages: SpecPageCandidate[] = [];
    for (let b = 0; b * DISCOVER_BATCH < pages.length; b += 1) {
      const slice = pages.slice(b * DISCOVER_BATCH, (b + 1) * DISCOVER_BATCH);
      const batch = await step.do(`read pages ${b + 1}`, { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "3 minutes" }, async () => {
        const links: Found[] = [];
        const tables: SpecPageCandidate[] = [];
        for (const page of slice) {
          try {
            const html = await fetchText(page);
            links.push(...documentLinks(html, page, domains));
            // The page is already here for its links. Judging it as a specification table too
            // costs nothing and is how the feed list stops being hand-typed.
            const candidate = judgeSpecPage(page, html);
            if (candidate) tables.push(candidate);
          } catch {
            // One page that will not load costs its own links and nothing else.
          }
        }
        return { links, tables };
      });
      for (const f of batch.links) if (!found.some((x) => x.url === f.url)) found.push(f);
      specPages.push(...batch.tables);
      await step.sleep(`politeness after pages ${b + 1}`, "2 seconds");
    }
    if (specPages.length > 0) {
      await step.do("write the specification pages this maker publishes", async () => {
        const ranked = specPages.sort((a, b) => b.withUnit - a.withUnit || b.figures - a.figures);
        await this.env.ARCHIVE.put(`${prefix}/spec-pages.json`, JSON.stringify({ manufacturer: manufacturerId, checkedAt, candidates: ranked.length, pages: ranked }, null, 2), {
          httpMetadata: { contentType: "application/json" },
        });
      });
    }

    console.log(JSON.stringify({ message: "discovery finished", manufacturer: manufacturerId, documents: found.length, specPages: specPages.length }));
    const plan = planFor(manufacturerId, found);
    await step.do("write the plan", async () => {
      await this.env.ARCHIVE.put(`${prefix}/plan.json`, JSON.stringify({ ...plan, checkedAt, documents: found }, null, 2), { httpMetadata: { contentType: "application/json" } });
    });
    console.log(JSON.stringify({ message: "awaiting approval", ...plan, checkedAt }));

    if (found.length === 0) return { manufacturer: manufacturerId, fetched: 0, reason: "nothing found to fetch" };

    // Everything above only read pages the maker already publishes to search engines. What
    // follows pulls files, so it does not start until a person says so.
    let approval: CrawlApproval;
    try {
      // The payload is whatever a caller sent, so it is parsed rather than trusted.
      const answer = await step.waitForEvent<CrawlApproval>(`approval to fetch ${found.length} documents`, { type: APPROVAL_EVENT, timeout: APPROVAL_TIMEOUT });
      approval = CrawlApproval.parse(answer.payload);
    } catch (error) {
      const reason = error instanceof Error && /timed? ?out/i.test(error.message) ? "no answer within the window" : `approval unreadable: ${error instanceof Error ? error.message : String(error)}`;
      console.log(JSON.stringify({ message: "not approved, nothing fetched", manufacturer: manufacturerId, reason }));
      return { manufacturer: manufacturerId, fetched: 0, reason };
    }
    const wanted = permitted(found, approval);
    if (wanted.length === 0) {
      console.log(JSON.stringify({ message: "approval permitted nothing", manufacturer: manufacturerId, approvedBy: approval.approvedBy }));
      return { manufacturer: manufacturerId, fetched: 0, reason: "approval permitted no host" };
    }

    const stored: { url: string; sha256: string; bytes: number; contentType: string }[] = [];
    let failed = 0;
    for (let b = 0; b * FETCH_BATCH < wanted.length; b += 1) {
      const slice = wanted.slice(b * FETCH_BATCH, (b + 1) * FETCH_BATCH);
      const batch = await step.do(`fetch documents ${b + 1}`, { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        const kept: typeof stored = [];
        let errors = 0;
        for (const doc of slice) {
          try {
            const response = await fetch(doc.url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
            const contentType = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
            // Keyed by content, so a retry rewrites the same object and a document that moved
            // to a new url is stored once, not twice.
            await this.env.ARCHIVE.put(`archive/${sha256}`, bytes, { httpMetadata: { contentType } });
            kept.push({ url: doc.url, sha256, bytes: bytes.byteLength, contentType });
          } catch {
            errors += 1;
          }
        }
        return { kept, errors };
      });
      stored.push(...batch.kept);
      failed += batch.errors;
      await step.sleep(`politeness after documents ${b + 1}`, "3 seconds");
    }

    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(`${prefix}/manifest.json`, JSON.stringify({
        manufacturer: manufacturerId, checkedAt, approvedBy: approval.approvedBy, ...(approval.note ? { note: approval.note } : {}),
        offered: found.length, fetched: stored.length, unreachable: failed, documents: stored,
      }, null, 2), { httpMetadata: { contentType: "application/json" } });
    });
    console.log(JSON.stringify({ message: "manufacturer crawl finished", manufacturer: manufacturerId, approvedBy: approval.approvedBy, fetched: stored.length, unreachable: failed }));
    return { manufacturer: manufacturerId, approvedBy: approval.approvedBy, fetched: stored.length, unreachable: failed };
  }
}

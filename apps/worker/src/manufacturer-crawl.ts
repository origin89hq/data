import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  APPROVAL_EVENT,
  CrawlApproval,
  type Found,
  permitted,
  planFor,
} from "@origin89/equipment-schema/documents";
import { observeCollection, workflowActivity } from "./activity.ts";
import {
  type DiscoverySeen,
  discoverPages,
  hopOrder,
  nextHop,
  type PagesRead,
  readPages,
} from "./discover.ts";
import { todayUtc, USER_AGENT } from "./feeds.ts";
import { pointerKey, runPrefix, writePointer } from "./runs.ts";
import { sample } from "./sitemap.ts";
import type { SpecPageCandidate } from "./spec-table.ts";

export interface ManufacturerCrawlParams {
  /** This attempt's instance id, recorded on the pointer so a caller can approve without it. */
  instanceId: string;
  /** The run this attempt writes under. Nothing else writes there, so nothing is overwritten. */
  run: string;
  manufacturerId: string;
  /** Hosts this maker claims, from its record. The instance knows no others and can reach no others. */
  domains: string[];
  checkedAt: string;
  initiatedBy?: string;
  /** How many pages of the site to read for links. Discovery is cheap; downloading is not. */
  pageLimit?: number;
}

/** The event a person sends to let the download start. Nothing happens without it. */

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
    return observeCollection(
      this.env.ARCHIVE,
      step,
      {
        entity: event.payload.manufacturerId,
        actor: event.payload.initiatedBy ?? "Collection workflow",
        run: { kind: "maker", id: event.payload.run, instance: event.instanceId },
      },
      () => this.collect(event, step),
    );
  }

  private async collect(event: WorkflowEvent<ManufacturerCrawlParams>, step: WorkflowStep) {
    const { instanceId, run, manufacturerId, domains, checkedAt, pageLimit } = event.payload;
    if (domains.length === 0)
      throw new Error(`${manufacturerId}: no domains, so there is nothing this instance may reach`);
    const prefix = runPrefix.documents(manufacturerId, run);
    // The pointer moves first so an approval can find this run while it is still working. Nothing
    // is cleared and nothing overwritten: the previous run's objects stay exactly where they are,
    // which is what keeps a run in progress from damaging the last good one.
    await step.do("become this maker's current run", () =>
      writePointer(this.env.ARCHIVE, pointerKey.documents(manufacturerId), {
        run,
        date: checkedAt,
        instance: instanceId,
        startedAt: new Date().toISOString(),
      }),
    );

    // The whole page budget: what the sitemap lists, and after that what those pages link. The
    // routes check the limit before a run starts; a budget that is not a whole number would let
    // the hop read every link it found, so a bad one is the default rather than open-ended.
    const budget =
      Number.isSafeInteger(pageLimit) && (pageLimit as number) > 0 ? (pageLimit as number) : 200;
    const { pages, hosts, listed } = await step.do(
      "discover pages",
      { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "3 minutes" },
      async () => {
        const discovered = await discoverPages(domains);
        return {
          pages: sample(discovered.pages, budget),
          hosts: discovered.hosts,
          listed: discovered.pages.length,
        };
      },
    );

    const found: Found[] = [];
    const specPages: SpecPageCandidate[] = [];
    // What the pages answered, kept beside the plan: a plan that offers nothing has to say whether
    // the site refused, moved, keeps its documents elsewhere, or simply links none (#48).
    const seen: DiscoverySeen = {
      hosts,
      pages: { listed, read: 0, followed: 0, failed: {} },
      foreignDocumentHosts: {},
      redirectedTo: [...new Set(hosts.flatMap((h) => h.redirectedTo))].sort(),
    };
    // Distinct documents on hosts the record does not claim: the same CDN manual linked from
    // twenty pages is one document to report.
    const foreignSeen = new Map<string, Set<string>>();
    // Pages already read or queued, and where a read page actually landed, so a link back to one
    // of them is not a page to follow.
    const queued = new Set(pages);
    const landedAt = new Set<string>();
    const candidates: string[] = [];
    const take = (batch: PagesRead): void => {
      for (const f of batch.links) if (!found.some((x) => x.url === f.url)) found.push(f);
      specPages.push(...batch.tables);
      for (const url of batch.landed) {
        queued.add(url);
        landedAt.add(url);
      }
      for (const link of batch.pages)
        if (!queued.has(link)) {
          queued.add(link);
          candidates.push(link);
        }
      seen.pages.read += batch.read;
      if (batch.linksDropped > 0)
        seen.pages.linksDropped = (seen.pages.linksDropped ?? 0) + batch.linksDropped;
      for (const [status, n] of Object.entries(batch.failed))
        seen.pages.failed[status] = (seen.pages.failed[status] ?? 0) + n;
      for (const [host, urls] of Object.entries(batch.foreign)) {
        const known = foreignSeen.get(host) ?? new Set<string>();
        for (const url of urls) known.add(url);
        foreignSeen.set(host, known);
        seen.foreignDocumentHosts[host] = known.size;
      }
      seen.redirectedTo = [...new Set([...seen.redirectedTo, ...batch.redirectedTo])].sort();
    };
    const reading = {
      retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      timeout: "3 minutes",
    } as const;
    for (let b = 0; b * DISCOVER_BATCH < pages.length; b += 1) {
      const slice = pages.slice(b * DISCOVER_BATCH, (b + 1) * DISCOVER_BATCH);
      take(await step.do(`read pages ${b + 1}`, reading, () => readPages(slice, domains)));
      await step.sleep(`politeness after pages ${b + 1}`, "2 seconds");
    }

    // One hop further, on what is left of the budget: a current product page a stale sitemap
    // leaves out is one link from a category page that it does list, and a maker with no sitemap
    // at all has only its home page to start from. Product and download pages go first, and a run
    // costs what it cost before, since the hop spends the same budget the sitemap did not.
    // The frontier is drawn on batch by batch, skipping any address a page has since landed on:
    // a followed page that redirects to a later candidate makes that candidate a page already
    // read, and the slot goes to the next one instead.
    const frontier = hopOrder(candidates);
    let remaining = Math.max(0, budget - pages.length);
    let cursor = 0;
    let followed = 0;
    for (let b = 0; remaining > 0 && cursor < frontier.length; b += 1) {
      const next = nextHop(frontier, cursor, landedAt, Math.min(DISCOVER_BATCH, remaining));
      cursor = next.cursor;
      if (next.slice.length === 0) break;
      const slice = next.slice;
      const batch = await step.do(`follow links ${b + 1}`, reading, () =>
        readPages(slice, domains),
      );
      take(batch);
      remaining -= slice.length;
      followed += slice.length;
      seen.pages.followed = (seen.pages.followed ?? 0) + batch.read;
      await step.sleep(`politeness after links ${b + 1}`, "2 seconds");
    }
    // What the budget did not reach, so a plan built from a hop that stopped short says so.
    const unfollowed = nextHop(frontier, cursor, landedAt, Number.MAX_SAFE_INTEGER).slice.length;
    if (unfollowed > 0) seen.pages.unfollowed = unfollowed;
    if (specPages.length > 0) {
      await step.do("write the specification pages this maker publishes", async () => {
        const ranked = specPages.sort((a, b) => b.withUnit - a.withUnit || b.figures - a.figures);
        await this.env.ARCHIVE.put(
          `${prefix}/spec-pages.json`,
          JSON.stringify(
            { manufacturer: manufacturerId, checkedAt, candidates: ranked.length, pages: ranked },
            null,
            2,
          ),
          {
            httpMetadata: { contentType: "application/json" },
          },
        );
      });
    }

    console.log(
      JSON.stringify({
        message: "discovery finished",
        manufacturer: manufacturerId,
        documents: found.length,
        specPages: specPages.length,
        pagesRead: seen.pages.read,
        pagesFollowed: seen.pages.followed,
        pagesFailed: seen.pages.failed,
        foreignDocumentHosts: seen.foreignDocumentHosts,
        redirectedTo: seen.redirectedTo,
      }),
    );
    const plan = planFor(manufacturerId, found);
    await step.do("write the plan", async () => {
      await this.env.ARCHIVE.put(
        `${prefix}/plan.json`,
        JSON.stringify({ ...plan, checkedAt, documents: found, discovery: seen }, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      );
    });
    console.log(JSON.stringify({ message: "awaiting approval", ...plan, checkedAt }));

    if (found.length === 0)
      return { manufacturer: manufacturerId, fetched: 0, reason: "nothing found to fetch" };

    const activity = {
      entity: manufacturerId,
      actor: event.payload.initiatedBy ?? "Collection workflow",
      run: { kind: "maker" as const, id: run, instance: event.instanceId },
    };
    await workflowActivity(
      this.env.ARCHIVE,
      step,
      activity,
      "waiting",
      `Waiting for approval to fetch ${found.length} documents`,
    );

    // Everything above only read pages the maker already publishes to search engines. What
    // follows pulls files, so it does not start until a person says so.
    let approval: CrawlApproval;
    try {
      // The payload is whatever a caller sent, so it is parsed rather than trusted.
      const answer = await step.waitForEvent<CrawlApproval>(
        `approval to fetch ${found.length} documents`,
        { type: APPROVAL_EVENT, timeout: APPROVAL_TIMEOUT },
      );
      approval = CrawlApproval.parse(answer.payload);
    } catch (error) {
      const reason =
        error instanceof Error && /timed? ?out/i.test(error.message)
          ? "no answer within the window"
          : `approval unreadable: ${error instanceof Error ? error.message : String(error)}`;
      console.log(
        JSON.stringify({
          message: "not approved, nothing fetched",
          manufacturer: manufacturerId,
          reason,
        }),
      );
      await workflowActivity(
        this.env.ARCHIVE,
        step,
        activity,
        "decided",
        reason,
        "Approval window",
      );
      return { manufacturer: manufacturerId, fetched: 0, reason };
    }
    const wanted = permitted(found, approval);
    await workflowActivity(
      this.env.ARCHIVE,
      step,
      activity,
      "decided",
      `${wanted.length} of ${found.length} documents permitted`,
      approval.approvedBy,
    );
    if (wanted.length === 0) {
      console.log(
        JSON.stringify({
          message: "approval permitted nothing",
          manufacturer: manufacturerId,
          approvedBy: approval.approvedBy,
        }),
      );
      return { manufacturer: manufacturerId, fetched: 0, reason: "approval permitted no host" };
    }

    const stored: { url: string; sha256: string; bytes: number; contentType: string }[] = [];
    let failed = 0;
    for (let b = 0; b * FETCH_BATCH < wanted.length; b += 1) {
      const slice = wanted.slice(b * FETCH_BATCH, (b + 1) * FETCH_BATCH);
      const batch = await step.do(
        `fetch documents ${b + 1}`,
        {
          retries: { limit: 2, delay: "20 seconds", backoff: "exponential" },
          timeout: "5 minutes",
        },
        async () => {
          const kept: typeof stored = [];
          let errors = 0;
          for (const doc of slice) {
            try {
              const response = await fetch(doc.url, {
                headers: { "user-agent": USER_AGENT },
                redirect: "follow",
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const bytes = await response.arrayBuffer();
              const digest = await crypto.subtle.digest("SHA-256", bytes);
              const sha256 = [...new Uint8Array(digest)]
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
              const contentType =
                response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
              // Keyed by content, so a retry rewrites the same object and a document that moved
              // to a new url is stored once, not twice.
              await this.env.ARCHIVE.put(`archive/${sha256}`, bytes, {
                httpMetadata: { contentType },
              });
              kept.push({ url: doc.url, sha256, bytes: bytes.byteLength, contentType });
            } catch {
              errors += 1;
            }
          }
          return { kept, errors };
        },
      );
      stored.push(...batch.kept);
      failed += batch.errors;
      await step.sleep(`politeness after documents ${b + 1}`, "3 seconds");
    }

    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(
        `${prefix}/manifest.json`,
        JSON.stringify(
          {
            // `checkedAt` names the run; `retrievedAt` is the day the bytes were actually fetched.
            manufacturer: manufacturerId,
            checkedAt,
            retrievedAt: todayUtc(),
            approvedBy: approval.approvedBy,
            ...(approval.note ? { note: approval.note } : {}),
            offered: found.length,
            fetched: stored.length,
            unreachable: failed,
            documents: stored,
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: "application/json" } },
      );
    });
    console.log(
      JSON.stringify({
        message: "manufacturer crawl finished",
        manufacturer: manufacturerId,
        approvedBy: approval.approvedBy,
        fetched: stored.length,
        unreachable: failed,
      }),
    );
    return {
      manufacturer: manufacturerId,
      approvedBy: approval.approvedBy,
      fetched: stored.length,
      unreachable: failed,
    };
  }
}

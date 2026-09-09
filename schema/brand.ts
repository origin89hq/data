import { z } from "zod";
import { RecordId } from "./enums.ts";

/** What a brand string turned out to be. `unresolved` is a real answer: seen, queued, not yet decided. */
export const BrandDecision = z.enum(["manufacturer", "out-of-scope", "unresolved"]);
export type BrandDecision = z.infer<typeof BrandDecision>;

/**
 * What the sightings say about a brand string, carried into the record so the person deciding
 * has the evidence in front of them and so a stale queue entry is visible. Counts are from the
 * crawl that last refreshed this record, not a running total.
 */
export const BrandEvidence = z
  .object({
    sellers: z.array(RecordId).min(1),
    listings: z.number().int().nonnegative(),
    /** Listings a classifier put in some kind other than out-of-scope. The number that decides whether this brand matters. */
    inScope: z.number().int().nonnegative(),
    kinds: z.array(z.string()).default([]),
    /** Model numbers read off the titles, which are usually what identifies the maker. */
    models: z.array(z.string()).default([]),
    /** Makers a classifier proposed. A suggestion to the reviewer and nothing more. */
    proposed: z.array(z.string()).default([]),
    examples: z.array(z.string()).default([]),
    seenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type BrandEvidence = z.infer<typeof BrandEvidence>;

/**
 * One brand string a seller printed, and what a person decided it is. This is the gate: nothing
 * crawls a manufacturer's site until a brand resolves to one here, so a reseller's own label and
 * a rebadged generic cannot quietly become a maker.
 */
export const Brand = z
  .object({
    id: RecordId,
    /** The string exactly as the seller printed it, which is what a sighting can be joined on. */
    brand: z.string().min(1),
    decision: BrandDecision,
    /** Set when the decision is `manufacturer`, and it must name one that exists. */
    manufacturer: RecordId.optional(),
    /** Set when the decision is `out-of-scope`: why this brand is not equipment worth a record. */
    reason: z.string().min(1).optional(),
    evidence: BrandEvidence,
    /** When a person decided. Absent while unresolved. */
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Who decided. A model is never a valid answer here. */
    reviewedBy: z.string().min(1).optional(),
  })
  .strict();
export type Brand = z.infer<typeof Brand>;

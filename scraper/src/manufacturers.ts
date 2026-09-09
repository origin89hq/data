import { z } from "zod";
import raw from "../manufacturers.json" with { type: "json" };

/** A maker discovery may look at, and the hosts it may look at. Generated from the records by `just export-makers`. */
export const CrawlableMaker = z
  .object({ id: z.string().min(1), domains: z.array(z.string().min(1)).min(1) })
  .strict();
export type CrawlableMaker = z.infer<typeof CrawlableMaker>;

/** Parsed once at module load, so a bad entry fails the deploy rather than a crawl. */
export const manufacturers: CrawlableMaker[] = raw.map((m) => CrawlableMaker.parse(m));

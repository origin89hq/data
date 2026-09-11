import { z } from "zod";
import raw from "../manufacturers.json" with { type: "json" };

/**
 * A maker discovery may look at, the hosts it may look at, and what the records already cite on
 * those hosts. Generated from the records by `just export-makers`.
 */
export const CrawlableMaker = z
  .object({
    id: z.string().min(1),
    domains: z.array(z.string().min(1)).min(1),
    /** Hosts its pages keep documents on, from the record. Documents only: no page here is read. */
    documentHosts: z.array(z.string().min(1)).optional(),
    cited: z
      .object({ documents: z.array(z.string().url()), pages: z.array(z.string().url()) })
      .strict()
      .optional(),
  })
  .strict();
export type CrawlableMaker = z.infer<typeof CrawlableMaker>;

/** Parsed once at module load, so a bad entry fails the deploy rather than a crawl. */
export const manufacturers: CrawlableMaker[] = raw.map((m) => CrawlableMaker.parse(m));

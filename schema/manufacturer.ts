import { z } from "zod";
import { RecordId } from "./enums.ts";

/**
 * A company that makes equipment. Held apart from the brand strings sellers print, because one
 * maker wears several: Rolls, Rolls Battery and Surrette are one company, and the catalogue
 * already minted two dialect ids for one device by not settling that first.
 */
export const Manufacturer = z
  .object({
    id: RecordId,
    /** The name the company uses for itself, not the shortest one a seller prints. */
    name: z.string().min(1),
    website: z.string().url().optional(),
    /**
     * Hosts hop two may crawl for this maker's documents. A domain here is a statement that the
     * site belongs to this company; a reseller's domain does not go in.
     */
    domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
    country: z.string().length(2).optional(),
    /** Why this record exists, or what a reader has to know: a rename, a parent company, a line sold under someone else's label. */
    notes: z.string().optional(),
    /** Source records naming this company, where the catalogue already cites one. */
    sources: z.array(RecordId).optional(),
    /**
     * The company's mark, held in the archive at several widths. A logo is a trademark rather than
     * a work anybody can license, so the bytes are not published with the records: this says where
     * they came from and what they are, and the dataset carries the address of the copy.
     */
    logo: z
      .object({
        /** The image fetched, so a wrong mark can be traced back and a better source can replace it. */
        source: z.string().url(),
        /** Who published it: `maker` for the company's own site, `seller:<id>` for a shop's brand page. */
        from: z.string().regex(/^(maker|seller:[a-z0-9-]+)$/),
        /** The bytes fetched, so the same logo twice is the same logo. */
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** Widths written to the archive, smallest first. */
        widths: z.array(z.number().int().positive()).min(1),
        checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Manufacturer = z.infer<typeof Manufacturer>;

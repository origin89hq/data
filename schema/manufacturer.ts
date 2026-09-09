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
  })
  .strict();
export type Manufacturer = z.infer<typeof Manufacturer>;

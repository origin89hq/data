import { z } from "zod";
import { RecordId } from "./enums.ts";

/**
 * A company that makes equipment. Held apart from the brand strings sellers print, because one
 * maker wears several: Rolls, Rolls Battery and Surrette are one company, and the catalogue
 * already minted two dialect ids for one device by not settling that first.
 */
/**
 * A host name label by label: no label empty, none starting or ending with a hyphen. A typo such
 * as `cdn..shopify.com` would pass a looser pattern, never match a real host, and turn into a plan
 * that quietly reports the maker's documents as somebody else's.
 */
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** DNS allows 253 characters of name; a longer one resolves nowhere and matches nothing. */
const HOST_NAME_LENGTH = 253;

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
    /**
     * Hosts the maker's own pages keep its documents on without owning them: a shop's CDN, a
     * CloudFront distribution, a Contentful or Cloudinary account. A document on one of these is
     * offered only when a page on `domains` links it, and no page on them is ever read. Nine of
     * the makers whose discovery found nothing keep every PDF this way (#48). Which host to add
     * is read off an empty plan, which names the hosts the maker's pages linked.
     */
    documentHosts: z.array(z.string().max(HOST_NAME_LENGTH).regex(HOST_NAME)).optional(),
    country: z.string().length(2).optional(),
    /** Why this record exists, or what a reader has to know: a rename, a parent company, a line sold under someone else's label. */
    notes: z.string().optional(),
    /**
     * A retailer's own label, held as a maker for the products that carry no other. Its site hosts
     * its suppliers' manuals and certificates too, so a document in its runs is credited to it only
     * when the document names it (#30).
     */
    retailer: z.literal(true).optional(),
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

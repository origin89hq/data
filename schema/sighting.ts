import { z } from "zod";
import { RecordId } from "./enums.ts";

/**
 * One product seen at one seller on one day, as printed. Brand and model are the seller's
 * strings, not resolved identities: resolving them is the gate a person keeps. A sighting
 * is a fact about the seller and needs no review to be stored.
 */
export const Sighting = z
  .object({
    seller: RecordId,
    /** The seller's own product id, stable across crawls of the same shop. */
    productId: z.string().min(1),
    handle: z.string().min(1),
    url: z.string().url(),
    title: z.string().min(1),
    /** Brand as the seller prints it. May be a reseller's label, not the maker. */
    brand: z.string().optional(),
    /** The seller's category string, as printed. */
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    /** Seller's SKU, often the maker's model number, sometimes not. */
    sku: z.string().optional(),
    /** Variant label when the product has more than one, e.g. "24V / 100Ah". */
    variant: z.string().optional(),
    price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    currency: z.string().length(3),
    available: z.boolean().optional(),
    /** When the seller last changed the listing, as the seller reports it. */
    updatedAt: z.string().datetime({ offset: true }).optional(),
    /** The crawl date. Listings rot; a sighting without a date is a rumour. */
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type Sighting = z.infer<typeof Sighting>;

export const SellerKind = z.enum(["shopify"]);

/** A retailer the spider starts from. Hand-written; the spider never adds one. */
export const Seller = z
  .object({
    id: RecordId,
    name: z.string().min(1),
    url: z.string().url(),
    country: z.string().length(2),
    currency: z.string().length(3),
    kind: SellerKind,
  })
  .strict();
export type Seller = z.infer<typeof Seller>;

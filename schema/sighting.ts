import { z } from "zod";
import { RecordId } from "./enums.ts";

/** How a sighting was read. Feeds and JSON-LD are deterministic; a model is not, and says which model. */
export const Extractor = z.string().regex(/^(shopify-feed|woocommerce-feed|json-ld|ai:[\w./@:-]+)$/);
export type Extractor = z.infer<typeof Extractor>;

/** The shop platform, which decides the extractor: a feed where one exists, the page's JSON-LD otherwise. */
export const Platform = z.enum(["shopify", "woocommerce", "bigcommerce", "magento", "other"]);
export type Platform = z.infer<typeof Platform>;

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
    /** The maker's model number when the seller states it as its own field, as some do. Not derived from the title. */
    model: z.string().optional(),
    /** Variant label when the product has more than one, e.g. "24V / 100Ah". */
    variant: z.string().optional(),
    price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    currency: z.string().length(3),
    available: z.boolean().optional(),
    /** When the seller last changed the listing, as the seller reports it. */
    updatedAt: z.string().datetime({ offset: true }).optional(),
    /** The crawl date. Listings rot; a sighting without a date is a rumour. */
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Which extractor produced this row, so a consumer can weigh it and a better extractor can replace it. */
    extractor: Extractor,
  })
  .strict();
export type Sighting = z.infer<typeof Sighting>;

/** A retailer the spider starts from. Hand-written; the spider never adds one. */
export const Seller = z
  .object({
    id: RecordId,
    name: z.string().min(1),
    url: z.string().url(),
    country: z.string().length(2),
    currency: z.string().length(3),
    platform: Platform,
    /** The maker's own store. Still a seller, but its brand column is one value and its prices are list prices. */
    makerDirect: z.boolean().optional(),
  })
  .strict();
export type Seller = z.infer<typeof Seller>;

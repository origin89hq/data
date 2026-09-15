import { z } from "zod";
import { RecordId } from "./enums.ts";

/**
 * What a person read in a maker's readings and said no to, so the daily pull does not write it again.
 *
 * A figure deleted by hand comes back with the next pull while a run still produces it: readings are
 * kept, and the pull writes every figure they give unless a person holds it. Holding a figure keeps a
 * right value; a rejection keeps a wrong one out (#144, #146, #149). It names one of three things: a
 * whole document that is not the maker's ratings, such as a compatibility note, a test report or a
 * slide deck, or that rates only equipment this dataset does not cover, such as a lift truck's
 * battery; one figure of one document, by the model it was filed under and its printed name; or a
 * product name that is not a product of this maker, which the pull then never mints.
 */
export const Rejection = z
  .object({
    /**
     * The document, as a figure cites it: `doc-` and the first 32 hex digits of its sha256. It need
     * not have a source record, since a rejected document may have nothing left to cite.
     */
    source: RecordId.optional(),
    /** With `name`, the model the rejected figure was filed under. */
    model: RecordId.optional(),
    /** The rejected figure's printed name, matched whole, ignoring case and spacing. */
    name: z.string().min(1).optional(),
    /** A product name a document gives that is not this maker's product. */
    product: z.string().min(1).optional(),
    /** Why, in the document's own words where it has them, so a reviewer can check it. */
    reason: z.string().min(1),
    reviewedBy: z.string().min(1),
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .refine(
    (r) =>
      r.product !== undefined
        ? r.model === undefined && r.name === undefined
        : r.source !== undefined && (r.model === undefined) === (r.name === undefined),
    "a rejection names a product, a document, or one figure of a document by its model and name",
  );
export type Rejection = z.infer<typeof Rejection>;

export const Rejections = z
  .object({
    /** The manufacturer whose pull the rejections apply to, one file per maker. */
    id: RecordId,
    rejections: z.array(Rejection).min(1),
  })
  .strict();
export type Rejections = z.infer<typeof Rejections>;

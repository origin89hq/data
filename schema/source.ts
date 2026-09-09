import { z } from "zod";
import { RecordId } from "./enums.ts";

/**
 * Where a fact was read. A source with neither `url` nor `path` cannot be re-read by
 * anybody and is reported for review, not refused: the catalogue carries a few cited
 * only by title, and losing the citation would be worse than carrying it unlocated.
 */
export const Source = z
  .object({
    id: RecordId,
    url: z.string().url().optional(),
    /** A document held in the private archive, by the path it was filed under. Not redistributable unless `redistributable` says so. */
    path: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    publisher: z.string().min(1).optional(),
    revision: z.string().min(1).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Absent means nobody has checked the licence. `false` is a decision; absence is not. */
    redistributable: z.boolean().optional(),
  })
  .strict();
export type Source = z.infer<typeof Source>;

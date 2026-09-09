import { z } from "zod";
import { Family as FamilyId, RecordId } from "./enums.ts";

/**
 * The prose around a family's dialects: the file's introduction and any section
 * heading placed between entries. Counts and refiling lists are derived from the
 * dialect records at render time and are not stored.
 */
export const Family = z
  .object({
    id: FamilyId,
    /** Markdown from the title to the line before the dialect count. */
    intro: z.string().min(1),
    /** Markdown placed before a named dialect, for a section that groups the entries after it. */
    sections: z
      .array(z.object({ before: RecordId, markdown: z.string().min(1) }).strict())
      .optional(),
    /** Entry order in the rendered file. Dialect records do not carry a position. */
    order: z.array(RecordId).min(1),
  })
  .strict();
export type Family = z.infer<typeof Family>;

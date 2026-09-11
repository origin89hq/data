import { z } from "zod";
import { Citation } from "./dialect.ts";
import { Confidence, RecordId } from "./enums.ts";
import { EquipmentKind } from "./guess.ts";

/**
 * How a model came to be linked to a dialect (#84). `register-match` is a source showing the
 * model answers the dialect's registers, which is the rule in CONTRIBUTING; `vendor-doc` is the
 * maker's own document saying the model speaks it; `catalogue-name` is only the protocol
 * catalogue naming the model under the dialect, which is a claim and not a match.
 */
export const LinkEvidenceKind = z.enum(["register-match", "vendor-doc", "catalogue-name"]);
export type LinkEvidenceKind = z.infer<typeof LinkEvidenceKind>;

/** A model's link to a dialect, with what says so. A link with no source is refused. */
export const DialectLink = z
  .object({
    dialect: RecordId,
    evidence: z
      .object({
        kind: LinkEvidenceKind,
        sources: z.array(Citation).min(1),
      })
      .strict(),
    /** What the sources support for this link, in the catalogue's vocabulary. */
    confidence: Confidence,
    /** The firmware the link is known to hold for, when a source says; absent means unstated, never all. */
    firmware: z
      .object({ min: z.string().min(1).optional(), max: z.string().min(1).optional() })
      .strict()
      .refine((f) => f.min !== undefined || f.max !== undefined, "a firmware range names a bound")
      .optional(),
  })
  .strict();
export type DialectLink = z.infer<typeof DialectLink>;

/**
 * One product a manufacturer makes. Held apart from a dialect's model list and from a seller's
 * listing, both of which name models without owning them: this is the record everything else
 * joins to, and the reason a rating can be attached to a thing rather than to a string.
 */
export const Model = z
  .object({
    id: RecordId,
    manufacturer: RecordId,
    /** The name on the case, as the maker writes it. */
    name: z.string().min(1),
    /**
     * What the thing is, when something has said so. Absent is a real answer: a listing nobody
     * has classified has no kind, and defaulting one would be a guess wearing the shape of a fact.
     */
    kind: EquipmentKind.optional(),
    /**
     * What tells two identical names apart: the AC voltage on an inverter, the current on a
     * charge controller, the `-48` on a pack. Never folded into `name`, because a suffix is the
     * difference between two products and a bench day lost.
     */
    variant: z.string().min(1).optional(),
    /** The line a model belongs to, when the maker documents one map or one sheet per family. */
    family: z.string().min(1).optional(),
    /** Other strings that name this model: a seller's SKU, a maker's part number, an older name. */
    aliases: z.array(z.string().min(1)).default([]),
    /** Dialects this model is known to speak, each with the evidence that says so. */
    dialects: z.array(DialectLink).default([]),
    checkedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    reviewedBy: z.string().min(1).optional(),
    /** What settled that this is a real model of this maker, rather than a string off a listing. */
    basis: z.string().min(1).optional(),
  })
  .strict();
export type Model = z.infer<typeof Model>;

/** How much weight a figure carries, using the catalogue's vocabulary so one word means one thing everywhere. */
export const SpecConfidence = z.enum([
  "vendor-doc",
  "community-crosschecked",
  "community-single",
  "unverified",
]);

/**
 * One rated figure, in long format. Not columns: a battery and an inverter share almost no
 * fields, and a single `capacity_ah` column would have to pick one discharge rate and lie. The
 * Rolls S-550's 428 Ah at C20 and 556 Ah at C100 are two rows, each carrying its own conditions.
 */
export const Spec = z
  .object({
    id: RecordId,
    model: RecordId,
    /** What is measured, in the words the datasheet uses: "Rated capacity", "Maximum PV input voltage". */
    name: z.string().min(1),
    /**
     * The same name in English, when the maker printed it in another language. A maker's multilingual
     * guide gives one figure four names, and without this a consumer cannot group "Capacité de
     * batterie" with "Battery capacity". Absent when nobody has given it one: the printed name is the
     * record, this is the aligned name beside it.
     */
    english: z.string().min(1).optional(),
    /** The figure as printed. A string, so "12/24" and "0.05" survive exactly and no float rounds them. */
    value: z.string().min(1),
    /** Absent for a figure that has none, such as a battery chemistry or a connector type. */
    unit: z.string().min(1).optional(),
    /**
     * What the figure is true under: the discharge rate, the temperature, the bank voltage. A
     * capacity without its rate is not a capacity, and this is where that is said.
     */
    conditions: z.string().min(1).optional(),
    source: RecordId,
    /**
     * What read this figure and how. `ai:` is a model reading prose, which is usable and not
     * confirmed — the source is the maker's own sheet, but nobody checked the number came off
     * the right row. `table:` is a parser reading the maker's own specification table, which is
     * exact but still nobody's decision about whether the table says what it appears to.
     */
    extractedBy: z
      .string()
      .regex(/^(ai|table):[\w./@:-]+$/)
      .optional(),
    /** Who confirmed the figure against the document, and when. Absent until somebody has. */
    reviewedBy: z.string().min(1).optional(),
    checkedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** The page it was read from, when the source is a document. A figure nobody can find again is not checkable. */
    page: z.number().int().positive().optional(),
    confidence: SpecConfidence,
  })
  .strict();
export type Spec = z.infer<typeof Spec>;

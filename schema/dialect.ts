import { z } from "zod";
import {
  CommandKind,
  Confidence,
  DriverStatus,
  Family,
  MetricKind,
  RecordId,
  RefuterStatus,
  Tier,
} from "./enums.ts";

/** One row of the model table. `name` is the string on the case; the split into manufacturer and variant is a review job. */
export const DialectModel = z
  .object({
    name: z.string().min(1),
    tier: Tier.optional(),
    rating: z.string().optional(),
    soldBy: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();
export type DialectModel = z.infer<typeof DialectModel>;

/** A citation on a dialect: which source, and the sentence the catalogue wrote next to it. */
export const Citation = z
  .object({
    source: RecordId,
    citation: z.string().min(1),
  })
  .strict();
export type Citation = z.infer<typeof Citation>;

export const Driver = z
  .object({
    status: DriverStatus,
    /** The driver's name when one is shipped. */
    id: RecordId.optional(),
    note: z.string().optional(),
  })
  .strict();

/**
 * A dialect is a register map or frame layout that owns a driver. Models land on a
 * dialect only when a source shows matching addresses. Prose fields are kept as the
 * catalogue wrote them; structuring transport and blocks is per-row review work.
 */
export const Dialect = z
  .object({
    id: RecordId,
    family: Family,
    driver: Driver,
    confidence: Confidence,
    refuter: RefuterStatus,
    /** Text the catalogue put after the confidence tag, when it was not the refuter note. */
    confidenceNote: z.string().optional(),
    /** Sibling ids this entry may duplicate. Cross-referenced, never merged: some pairs are genuinely two devices. */
    seeAlso: z.array(RecordId).min(1).optional(),
    sources: z.array(Citation).min(1),
    /** A pointer outside the catalogue, kept as the markdown the catalogue wrote. */
    crossReference: z.string().min(1).optional(),
    transport: z.string().optional(),
    blocks: z.string().optional(),
    reports: z.array(MetricKind).optional(),
    accepts: z.array(CommandKind).optional(),
    models: z.array(DialectModel).optional(),
    /** Why several models are listed under one map. Absent on a single-model entry. */
    sharedMapEvidence: z.string().optional(),
    refutedOnReview: z.string().optional(),
    /** The refuter dropped the shared-map claim: the models are listed together because an agent proposed it, not because a source shows matching addresses. */
    sharedMapClaimDropped: z.boolean().optional(),
    downgradedOnReview: z.string().optional(),
    gotchas: z.array(z.string().min(1)).optional(),
    /** Things the device reports that the metric vocabulary cannot name. One paragraph; splitting it is review work. */
    unmappedReports: z.string().optional(),
    /** The label the entry was researched under before it was refiled here. A label, not a family: some named a family this catalogue does not declare. */
    refiledFrom: z.string().regex(/^[a-z0-9-]+$/).optional(),
    /** Left as found next to a sibling id; merging without re-reading the sources would destroy evidence. */
    possibleDuplicate: z.boolean().optional(),
  })
  .strict();
export type Dialect = z.infer<typeof Dialect>;

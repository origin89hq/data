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

/**
 * One reading a dialect gives, structured (#84): which metric, where it is, what the raw value
 * means. `at` is the register, field or label as the document writes it. A scale needs a unit,
 * since a bare multiplier says nothing; a value that spans registers says how many and which
 * comes first. `origin` says whether the device measured the value, estimated it or only
 * reports what something else told it. Every reading cites the document it was read from.
 */
export const DialectReading = z
  .object({
    metric: MetricKind,
    at: z.string().min(1),
    unit: z.string().min(1).optional(),
    /** Multiply the raw value by this for the unit. Absent means the raw value is the value. */
    scale: z.number().positive().optional(),
    signed: z.boolean().optional(),
    words: z.number().int().min(2).max(4).optional(),
    order: z.enum(["low-first", "high-first"]).optional(),
    /** A raw value that means the reading is absent rather than zero. */
    sentinel: z.string().min(1).optional(),
    /** Only some models of the dialect give this reading; this says what decides it, and a consumer checks the model before polling. */
    conditional: z.string().min(1).optional(),
    origin: z.enum(["measured", "estimated", "reported"]),
    source: RecordId,
    citation: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
  })
  .strict()
  .refine((r) => r.scale === undefined || r.unit !== undefined, "a scale needs a unit")
  .refine((r) => r.order === undefined || r.words !== undefined, "an order needs words")
  .refine(
    (r) => r.words === undefined || r.order !== undefined,
    "a value over several registers needs its word order",
  );
export type DialectReading = z.infer<typeof DialectReading>;

/** The most readings and code entries one dialect may carry: a register map is a few hundred rows at most, and a bundle's dialects are read whole. */
export const DIALECT_READINGS = 256;
export const DIALECT_CODES = 512;

/** One entry of a vendor code table (#84): what a fault, alarm, charge stage or state code means, with its source. */
export const DialectCode = z
  .object({
    table: z.enum(["fault", "alarm", "charge-stage", "state"]),
    /** The register, field or bits the code is read at, when the table lives in one place. */
    at: z.string().min(1).optional(),
    code: z.string().min(1),
    meaning: z.string().min(1),
    source: RecordId,
    citation: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
  })
  .strict();
export type DialectCode = z.infer<typeof DialectCode>;

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
    /**
     * The company whose device speaks this. Absent when it is one we do not hold a record for, or
     * when the entry is not a maker's map at all.
     *
     * The catalogue was written with the maker as a prefix on the id — `victron-mppt-vedirect-hex`
     * — which is a convention and not a key. Nothing could join a protocol to a product: 1,124
     * model entries lived inside dialects and not one reached a model record, because there was
     * nothing to scope a name against.
     */
    manufacturer: RecordId.optional(),
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
    /** The readings, structured, where somebody has done the work; `blocks` stays the prose until every reading it describes is here. */
    readings: z.array(DialectReading).min(1).max(DIALECT_READINGS).optional(),
    /** The vendor's code tables, structured. */
    codes: z.array(DialectCode).min(1).max(DIALECT_CODES).optional(),
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
    refiledFrom: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /** Left as found next to a sibling id; merging without re-reading the sources would destroy evidence. */
    possibleDuplicate: z.boolean().optional(),
  })
  .strict();
export type Dialect = z.infer<typeof Dialect>;

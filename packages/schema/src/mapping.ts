import { z } from "zod";
import { RecordId } from "./enums.ts";
import { ConditionKey, Conditions } from "./properties.ts";

/**
 * How one maker's printed figures reach the property registry.
 *
 * Translating a name into English does not make two properties the same: "Max. input voltage" is
 * the PV open-circuit limit on Victron's sheets and may be something else on another maker's, so
 * a rule is scoped to one maker and, when the wording is one document's, to that document. A
 * rule is reviewed in a pull request like any record; it is not a review of the figures it reads.
 */
export const MappingRule = z
  .object({
    /** A key from the property registry. */
    key: z.string().regex(/^[a-z]+(\.[a-z]+)+$/),
    /** The names the maker prints the figure under, matched whole, ignoring case and spacing. */
    names: z.array(z.string().min(1)).min(1),
    /** Only figures read from this source, when the wording is one document's. */
    source: RecordId.optional(),
    /** The unit to read a value with when the figure prints none: "120-950" on a sheet whose table header says V. */
    unit: z.string().min(1).optional(),
    /** Conditions the rule states for every figure it reads, where the sheet states them once for the table. */
    conditions: Conditions.optional(),
    /**
     * Conditions a figure must state to be usable under this rule, beyond what the key needs: a
     * PV power limit the sheet gives per system voltage is a gap until the bank voltage is read.
     */
    requires: z.array(ConditionKey).optional(),
    scope: z.enum(["per-input", "total"]).optional(),
    /** Why the rule is right, in the sheet's own words, so a reviewer can check it. */
    basis: z.string().min(1),
  })
  .strict();
export type MappingRule = z.infer<typeof MappingRule>;

export const Mapping = z
  .object({
    /** The manufacturer the rules are for; one file per maker. */
    id: RecordId,
    /** Bumped when a rule changes, so a property says which version read it. */
    version: z.number().int().positive(),
    reviewedBy: z.string().min(1),
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rules: z.array(MappingRule).min(1),
  })
  .strict();
export type Mapping = z.infer<typeof Mapping>;

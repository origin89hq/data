import { z } from "zod";
import { RecordId } from "./enums.ts";
import { ConditionKey, Conditions } from "./properties.ts";

/**
 * How printed figures reach the property registry.
 *
 * Translating a name into English does not make two properties the same: "Max. input voltage" is
 * the PV open-circuit limit on Victron's sheets and may be something else on another maker's, so
 * a rule is scoped to one maker and, when the wording is one document's, to that document. A
 * rule is reviewed in a pull request like any record; it is not a review of the figures it reads.
 *
 * Some names say in full what they measure wherever they are printed: "Maximum PV open circuit
 * voltage" is the same limit on every sheet. Those live in one shared mapping, [`SHARED_MAPPING`],
 * which applies to every maker for the figures its own rules do not name. A maker's file then
 * carries only its own wording, and the names in [`Mapping.except`] that mean something else on
 * its sheets.
 */

/** The id of the mapping that applies to every maker; `records/mappings/shared.json`. */
export const SHARED_MAPPING = "shared";
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
    /**
     * Which slash-separated part of the value the rule reads, counted from one, where a sheet
     * prints two figures in one cell: "Watts (Starting/Running)" = "5500/4000" is the starting
     * watts to a rule with part 1 and the running watts to one with part 2. A figure with fewer
     * parts is not read by the rule.
     */
    part: z.number().int().positive().optional(),
    /** Why the rule is right, in the sheet's own words, so a reviewer can check it. */
    basis: z.string().min(1),
  })
  .strict();
export type MappingRule = z.infer<typeof MappingRule>;

export const Mapping = z
  .object({
    /** The manufacturer the rules are for, one file per maker, or [`SHARED_MAPPING`]. */
    id: RecordId,
    /** Bumped when a rule changes, so a property says which version read it. */
    version: z.number().int().positive(),
    reviewedBy: z.string().min(1),
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rules: z.array(MappingRule).min(1),
    /**
     * Names a shared rule lists that mean something else on this maker's sheets, matched like a
     * rule's names, so no shared rule reads them. A name this maker's own rules read needs no
     * entry: a maker's rule always comes before the shared one.
     */
    except: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Mapping = z.infer<typeof Mapping>;

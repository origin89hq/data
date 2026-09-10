import { z } from "zod";
import { RecordId } from "./enums.ts";

/** The closed set of equipment kinds the database cares about, plus the one answer that keeps the gate short. */
export const EquipmentKind = z.enum([
  "charge-controller",
  "inverter",
  "inverter-charger",
  "battery",
  "bms",
  "shunt-monitor",
  "panel",
  "generator",
  "meter",
  "dc-dc-converter",
  "ac-charger",
  "balance-of-system",
  // What the system powers. Every kind above is a source, a store, a conversion, a control or a
  // wire, so a water pump had nowhere to go and 142 Pentair models claimed to be furniture. A pump
  // is usually the largest load on an off-grid site and a fridge is the one that runs all night;
  // deciding whether to start a generator for them is the controller's whole job.
  "pump",
  "appliance",
  /** Anything else that consumes: lighting, a camera, a cell booster, UV water treatment. */
  "load",
  /** A booster pack with its own battery. NOCO's range was spread across six kinds without it. */
  "jump-starter",
  "out-of-scope",
]);
export type EquipmentKind = z.infer<typeof EquipmentKind>;

/**
 * What a model proposed about one sighting. Kept apart from the as-printed fields: a guess is a
 * suggestion to the person at the gate, never a fact, and it names the model that made it.
 */
export const Guess = z
  .object({
    seller: RecordId,
    productId: z.string().min(1),
    kind: EquipmentKind,
    /** The maker's model number as the model read it off the title, or absent when it could not. */
    model: z.string().min(1).optional(),
    /** The manufacturer the model believes stands behind the brand string, which may differ from it. */
    manufacturer: z.string().min(1).optional(),
    /** The model answered with something outside the enum, so the kind is a fallback and not its reading. */
    unreadable: z.boolean().optional(),
    /** Which model and prompt version produced this row, so it can be re-run and compared. */
    by: z.string().regex(/^ai:[\w./@:-]+$/),
  })
  .strict();
export type Guess = z.infer<typeof Guess>;

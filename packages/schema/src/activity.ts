import { z } from "zod";

export const ActivityKind = z.enum([
  "collection_started",
  "collection_completed",
  "collection_failed",
  "approval_waiting",
  "approval_decided",
  "supervision",
  "release",
]);
export const ActivityEvent = z.object({
  id: z.string().min(1).max(250),
  at: z.iso.datetime(),
  kind: ActivityKind,
  entity: z.string().max(100),
  actor: z.string().max(250),
  summary: z.string().max(1000),
  run: z
    .object({ kind: z.enum(["maker", "seller"]), id: z.string(), instance: z.string() })
    .optional(),
  release: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;
export const ActivityPage = z.object({
  events: z.array(ActivityEvent),
  cursor: z.string().optional(),
  at: z.iso.datetime(),
});
export const ActivityQuery = z.object({
  kind: ActivityKind.optional(),
  q: z.string().trim().max(100).default(""),
  since: z.iso.datetime().optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

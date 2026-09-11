import type { WorkflowStep } from "cloudflare:workers";
import { ActivityEvent, type ActivityQuery } from "@origin89/equipment-schema/activity";
import type { z } from "zod";
import type { Caller } from "./sign-in.ts";

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const reverseTime = (at: string) => String(9999999999999 - Date.parse(at)).padStart(13, "0");
export function actor(caller: Caller): string {
  return caller.kind === "member"
    ? caller.login
    : caller.kind === "workflow"
      ? `${caller.workflow} run ${caller.runId}`
      : "Control token";
}

/** First writer fixes the event's time. Replays repair the index without adding another event. */
export async function recordActivity(bucket: R2Bucket, input: ActivityEvent): Promise<void> {
  const event = ActivityEvent.parse(input);
  const id = await digest(event.id);
  const key = `activity/events/${id}.json`;
  const created = await bucket.put(key, JSON.stringify(event), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const fixed = created ? event : ActivityEvent.parse(await (await bucket.get(key))?.json());
  await bucket.put(`activity/feed/${reverseTime(fixed.at)}-${id}.json`, JSON.stringify(fixed));
}

/** Observability failure must not turn a confirmed mutation into a request to repeat it. */
export async function noteActivity(bucket: R2Bucket, input: ActivityEvent): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await recordActivity(bucket, input);
      return;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "activity write failed",
          event: input.id,
          attempt,
          error: String(error),
        }),
      );
    }
  }
}

export async function activityPage(bucket: R2Bucket, query: z.infer<typeof ActivityQuery>) {
  const events: ActivityEvent[] = [];
  let cursor = query.cursor;
  // At most 125 reads; sparse filters still return a cursor instead of claiming history ended.
  for (let page = 0; page < 5; page++) {
    const listed = await bucket.list({
      prefix: "activity/feed/",
      limit: Math.min(25, query.limit - events.length),
      cursor,
    });
    for (const item of listed.objects) {
      const raw = await bucket.get(item.key);
      if (!raw) throw new Error("An activity entry is unavailable. Refresh to try again.");
      const event = ActivityEvent.parse(await raw.json());
      if (query.since && Date.parse(event.at) < Date.parse(query.since))
        return { events, at: new Date().toISOString() };
      const text = [event.entity, event.actor, event.summary, event.run?.instance]
        .join(" ")
        .toLowerCase();
      if ((!query.kind || event.kind === query.kind) && text.includes(query.q.toLowerCase()))
        events.push(event);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor || events.length === query.limit) break;
  }
  return { events, cursor, at: new Date().toISOString() };
}

export type Collection = Pick<ActivityEvent, "entity" | "actor"> & {
  run: NonNullable<ActivityEvent["run"]>;
};
export async function workflowActivity(
  bucket: R2Bucket,
  step: WorkflowStep,
  collection: Collection,
  phase: "started" | "completed" | "failed" | "waiting" | "decided",
  summary: string,
  by = collection.actor,
) {
  try {
    await step.do(
      `activity: ${phase}`,
      { retries: { limit: 2, delay: "2 seconds" }, timeout: "15 seconds" },
      async () => {
        await recordActivity(bucket, {
          ...collection,
          actor: by,
          id: `${collection.run.instance}:${phase}`,
          at: new Date().toISOString(),
          kind:
            phase === "waiting"
              ? "approval_waiting"
              : phase === "decided"
                ? "approval_decided"
                : `collection_${phase}`,
          summary: summary.slice(0, 1000),
        });
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "workflow activity unavailable",
        instance: collection.run.instance,
        phase,
        error: String(error),
      }),
    );
  }
}
function collectionSummary(result: unknown): string {
  if (!result || typeof result !== "object") return "Collection finished";
  const value = result as Record<string, unknown>;
  const details: string[] = [];
  if (typeof value.fetched === "number") details.push(`${value.fetched} documents collected`);
  if (typeof value.sightings === "number") details.push(`${value.sightings} seller sightings`);
  if (typeof value.unreachable === "number" && value.unreachable > 0)
    details.push(`${value.unreachable} documents unreachable`);
  if (typeof value.reason === "string") details.push(value.reason);
  return ["Collection finished", ...details].join(" · ");
}
export async function observeCollection<T>(
  bucket: R2Bucket,
  step: WorkflowStep,
  collection: Collection,
  work: () => Promise<T>,
): Promise<T> {
  await workflowActivity(bucket, step, collection, "started", "Collection started");
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await workflowActivity(
      bucket,
      step,
      collection,
      "failed",
      `Collection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  await workflowActivity(bucket, step, collection, "completed", collectionSummary(result));
  return result;
}

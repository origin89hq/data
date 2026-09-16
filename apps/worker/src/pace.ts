import type { Work } from "./work.ts";

/**
 * Turns with Kimi K2.7, which both readers call: the text reader for a converted document's windows
 * and the page reader for pages and transcripts. The account is served twenty requests a minute on
 * standard billing and `KIMI_PACE` allows eighteen, so the two readers share one budget. A call
 * turned away, by the pace or by Kimi's own limit, goes back on the queue to wait its turn instead of
 * counting as a failure: retried at once, all four deliveries of a page fell inside one minute of the
 * limit, and 1,996 of 2,148 pages were kept as failed (#29).
 */

type Paced = Extract<Work, { kind: "extract" | "vision-page" | "vision-window" }>;

/** The model, or the pace, said not yet. The refusal is not written down as the call's answer. */
export class NotYet extends Error {}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Workers AI's answer when an account is over a model's requests per minute. */
export const rateLimited = (error: unknown): boolean => /\b3021\b/.test(reason(error));

/**
 * Times a message is put back before a refusal counts as a failure like any other. Thirty waits,
 * most of them at the half-hour cap, is about half a day: longer than a backlog takes at the pace,
 * and still an end for a call the model never serves.
 */
export const MAX_WAITS = 30;

/**
 * The same for a converted document the text reader reads a window at a time. A backlog of a
 * thousand documents queued at once takes hours at the pace, and a document can go that long
 * without a turn; after its last wait it would call unpaced and have its windows written as failed.
 * Three hundred waits at the five-minute cap is about a day.
 */
export const MAX_DOCUMENT_WAITS = 300;

const maxWaits = (message: Paced): number =>
  message.kind === "extract" ? MAX_DOCUMENT_WAITS : MAX_WAITS;

/**
 * How long a message waits before it is tried again: a minute, doubling to half an hour, and up to
 * a minute more by its document and place, so a document's pages turned away together do not all
 * come back together. A document the text reader reads doubles to five minutes only: it asks a turn
 * for each of its windows, and at half an hour between turns a queue of them used under a third of
 * the pace (#198).
 */
export function waitFor(message: Paced): number {
  const waits = message.waits ?? 0;
  const cap = message.kind === "extract" ? 300 : 1800;
  const place =
    message.kind === "vision-page"
      ? message.page
      : message.kind === "vision-window"
        ? message.window
        : 0;
  const spread = (Number.parseInt(message.sha256.slice(0, 4), 16) + place) % 60;
  return Math.min(60 * 2 ** waits, cap) + spread;
}

/**
 * A turn with the model, asked before each call. Throws `NotYet` when the pace says no, and returns
 * whether the message may still wait: past its last wait nothing is held back, and whatever the
 * model says next is the answer.
 */
export async function takeTurn(env: Env, message: Paced, model: string): Promise<boolean> {
  const mayWait = (message.waits ?? 0) < maxWaits(message);
  if (mayWait && !(await env.KIMI_PACE.limit({ key: model })).success)
    throw new NotYet("over Kimi's pace");
  return mayWait;
}

/**
 * Put a message back on the queue to wait its turn, and say why in the logs. A message that got
 * something read before it was turned away had its turn, so its waiting starts over: it comes back
 * in a minute rather than after a wait that grew while it was reading.
 */
export async function waitTurn(
  env: Env,
  message: Paced,
  error: NotYet,
  progressed = false,
): Promise<void> {
  const next = { ...message, waits: progressed ? 0 : (message.waits ?? 0) + 1 };
  // Logged with its reason, so the logs say how often Kimi itself still refused. The pace is
  // counted per Cloudflare location, and a refusal past it is how that would show.
  console.log(
    JSON.stringify({
      message: `${message.kind === "vision-page" ? "page" : message.kind === "vision-window" ? "window" : "document"} waits its turn`,
      sha256: message.sha256,
      ...(message.kind === "vision-page" ? { page: message.page } : {}),
      ...(message.kind === "vision-window" ? { window: message.window } : {}),
      waits: next.waits,
      reason: error.message,
    }),
  );
  // A new message rather than a retry, so waiting its turn does not use up the deliveries it gets
  // for failures of its own.
  await env.WORK.send(next, { delaySeconds: waitFor(progressed ? next : message) });
}

import { Guess } from "@origin89/equipment-schema/guess";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import { BatchMisalignedError, CLASSIFIER_ID, classifierKey, classifyBatch } from "./classify.ts";
import { inputKey, partKey, type Work } from "./work.ts";

/**
 * Classify a batch, halving it whenever the model answers with the wrong number of items. A model
 * that collapses ten listings into one usually manages five, and retrying the same ten spends
 * attempts on the same question. The result is written under the original part's key however many
 * calls it took, so one part stays one key and a reader needs to know nothing about this.
 *
 * A single listing that still misaligns is genuinely stuck: it throws, the message retries, and
 * eventually it dead-letters where it can be looked at.
 */
export async function classifyInHalves(ai: Ai, sightings: Sighting[]): Promise<Guess[]> {
  try {
    return await classifyBatch(ai, sightings);
  } catch (error) {
    if (!(error instanceof BatchMisalignedError) || sightings.length < 2) throw error;
    const half = Math.ceil(sightings.length / 2);
    const [left, right] = await Promise.all([
      classifyInHalves(ai, sightings.slice(0, half)),
      classifyInHalves(ai, sightings.slice(half)),
    ]);
    return [...left, ...right];
  }
}

/**
 * The answer this classifier already gave the same question, as this listing's guess. Stored
 * answers carry only what was guessed, so the listing supplies who sold it and the key it sits
 * under says which classifier answered. One that no longer reads as a guess is asked again.
 */
async function answered(bucket: R2Bucket, sighting: Sighting): Promise<Guess | undefined> {
  const object = await bucket.get(partKey.classified(classifierKey(), await inputKey(sighting)));
  if (!object) return undefined;
  const stored = await object.json<unknown>().catch(() => undefined);
  if (typeof stored !== "object" || stored === null) return undefined;
  const guess = Guess.safeParse({
    ...stored,
    seller: sighting.seller,
    productId: sighting.productId,
    by: CLASSIFIER_ID,
  });
  return guess.success ? guess.data : undefined;
}

/**
 * One part of a run's classification: a guess for every listing, in the part's order.
 *
 * A listing answered before costs a read and no model call; only the rest are asked. Every listing
 * still gets its guess written here, under this run, because this run's parts are what the gate
 * reads. A run that skipped its answered listings left the gate with no kind for most of a shop
 * that had not changed (#16).
 */
export async function classifyPart(
  env: Env,
  message: Extract<Work, { kind: "classify" }>,
): Promise<void> {
  const known = await Promise.all(message.sightings.map((s) => answered(env.ARCHIVE, s)));
  const unanswered = message.sightings.filter((_, i) => !known[i]);
  const asked = unanswered.length > 0 ? await classifyInHalves(env.AI, unanswered) : [];
  // Answers are put back beside their listings by position, so a short one must not shift them.
  if (asked.length !== unanswered.length)
    throw new BatchMisalignedError(unanswered.length, asked.length);
  let next = 0;
  const guesses = known.map((guess) => guess ?? asked[next++]);
  await env.ARCHIVE.put(
    partKey.classify(classifierKey(), message.seller, message.run, message.part),
    `${guesses.map((g) => JSON.stringify(g)).join("\n")}\n`,
    {
      httpMetadata: { contentType: "application/x-ndjson" },
    },
  );
  // The new answers again, keyed by the question rather than by the run, so next week's crawl of
  // an unchanged listing costs nothing.
  await Promise.all(
    asked.map(async (guess, i) => {
      const sighting = unanswered[i];
      if (!sighting) return;
      await env.ARCHIVE.put(
        partKey.classified(classifierKey(), await inputKey(sighting)),
        JSON.stringify({
          kind: guess.kind,
          ...(guess.model ? { model: guess.model } : {}),
          ...(guess.manufacturer ? { manufacturer: guess.manufacturer } : {}),
          ...(guess.unreadable ? { unreadable: true } : {}),
        }),
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
    }),
  );
}

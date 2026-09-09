import { classifyBatch, classifierKey, CLASSIFIER_ID } from "./classify.ts";
import { contentOf } from "./classify.ts";
import { chunk, CONVERTER, EXTRACT_MODEL, EXTRACTOR_ID, RESPONSE_SCHEMA, SYSTEM, mergeReports, type Reported } from "./reading.ts";
import { inputKey, partKey, Work } from "./work.ts";
import { BatchMisalignedError } from "./classify.ts";
import type { Sighting } from "../../schema/sighting.ts";
import type { Guess } from "../../schema/guess.ts";

/**
 * One unit of fan-out work. Every kind writes its result to a key the producer can predict, so
 * nothing has to report back and a reader can tell a missing part from a short answer.
 *
 * A message that throws is retried by the queue and, once its attempts are spent, lands in the
 * dead-letter queue where it can be looked at. That is the behaviour the workflow version did not
 * have: there, one failing batch was caught, counted and forgotten.
 */
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
    const [left, right] = await Promise.all([classifyInHalves(ai, sightings.slice(0, half)), classifyInHalves(ai, sightings.slice(half))]);
    return [...left, ...right];
  }
}

export async function handle(message: Work, env: Env): Promise<void> {
  switch (message.kind) {
    case "classify": {
      const guesses = await classifyInHalves(env.AI, message.sightings);
      await env.ARCHIVE.put(partKey.classify(classifierKey(), message.seller, message.date, message.part), `${guesses.map((g) => JSON.stringify(g)).join("\n")}\n`, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
      // The same answer again, keyed by the question rather than by the run, so next week's crawl
      // of an unchanged listing costs nothing.
      await Promise.all(
        guesses.map(async (guess, i) => {
          const sighting = message.sightings[i];
          if (!sighting) return;
          await env.ARCHIVE.put(partKey.classified(classifierKey(), await inputKey(sighting)), JSON.stringify({ kind: guess.kind, ...(guess.model ? { model: guess.model } : {}), ...(guess.manufacturer ? { manufacturer: guess.manufacturer } : {}), ...(guess.unreadable ? { unreadable: true } : {}) }), {
            httpMetadata: { contentType: "application/json" },
          });
        }),
      );
      return;
    }
    case "convert": {
      const markdown = partKey.markdown(message.sha256, CONVERTER);
      const already = await env.ARCHIVE.head(markdown);
      if (!already) {
        const object = await env.ARCHIVE.get(`archive/${message.sha256}`);
        if (!object) throw new Error(`archive/${message.sha256} is not in the archive`);
        const blob = new Blob([await object.arrayBuffer()], { type: message.contentType });
        const name = new URL(message.url).pathname.split("/").pop() || message.sha256;
        const result = await env.AI.toMarkdown({ name, blob });
        const one = Array.isArray(result) ? result[0] : result;
        if (!one || one.format === "error" || typeof one.data !== "string") {
          // A scanned manual with no text layer is an answer about the maker's catalogue, not a
          // failure to retry. It is recorded and the message is done.
          await env.ARCHIVE.put(partKey.converted(message.manufacturer, message.date, message.sha256), JSON.stringify({ ...message, error: one?.error ?? "the converter returned no text" }), { httpMetadata: { contentType: "application/json" } });
          return;
        }
        await env.ARCHIVE.put(markdown, one.data, { httpMetadata: { contentType: "text/markdown" } });
      }
      const size = already?.size ?? (await env.ARCHIVE.head(markdown))?.size;
      await env.ARCHIVE.put(partKey.converted(message.manufacturer, message.date, message.sha256), JSON.stringify({ sha256: message.sha256, url: message.url, key: markdown, characters: size ?? 0 }), {
        httpMetadata: { contentType: "application/json" },
      });
      // Converting and reading are two units, and the second only exists once the first has
      // produced something. Chaining them here is what makes the pipeline run without a caller.
      await env.WORK.send({ kind: "extract", manufacturer: message.manufacturer, date: message.date, sha256: message.sha256, url: message.url, key: markdown });
      return;
    }
    case "extract": {
      const reading = partKey.reading(message.manufacturer, message.date, message.sha256, EXTRACTOR_ID.replace(/[^\w.-]+/g, "_"));
      // Reading a document is the expensive step, and the document is addressed by its content,
      // so a reading that exists is a reading of exactly these bytes by exactly this extractor.
      if (await env.ARCHIVE.head(reading)) return;
      const object = await env.ARCHIVE.get(message.key);
      if (!object) throw new Error(`${message.key} is gone`);
      const windows = chunk(await object.text()).slice(0, message.maxWindows ?? 60);
      const reports: Reported[] = [];
      let failed = 0;
      for (const window of windows) {
        try {
          const response = await env.AI.run(EXTRACT_MODEL, {
            messages: [{ role: "system", content: SYSTEM }, { role: "user", content: window.text }],
            response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
            max_tokens: 3072,
          } as never);
          const parsed = JSON.parse(contentOf(response)) as { products?: Reported[] };
          if (Array.isArray(parsed.products)) {
            for (const product of parsed.products) {
              if (!Array.isArray(product?.specs)) continue;
              // The page comes from where the window started, not from the model: an invented
              // page number is worse than none, because it looks checkable.
              reports.push({ ...product, specs: product.specs.map((s) => ({ ...s, ...(window.page === undefined ? {} : { page: window.page }) })) });
            }
          }
        } catch {
          failed += 1;
        }
      }
      await env.ARCHIVE.put(reading, JSON.stringify({ sha256: message.sha256, url: message.url, products: mergeReports(reports), windows: windows.length, failed }, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
      return;
    }
  }
}

/**
 * The queue handler. Messages are taken one at a time, not with Promise.all: a batch of ten
 * documents converted at once put ten PDFs into one isolate's memory and lost half of them. The
 * parallelism worth having is across consumers, which the queue's own concurrency provides;
 * inside one invocation it only shares a single memory and CPU budget between ten heavy jobs.
 *
 * Each message is acknowledged or retried on its own, so one bad document cannot take the rest
 * of its batch down with it.
 */
export async function consume(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
      try {
        await handle(Work.parse(message.body), env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ message: "work failed", attempt: message.attempts, error: error instanceof Error ? error.message : String(error) }));
        // A malformed message will never parse, however many times it is tried, so it goes
        // straight to the dead-letter queue instead of burning its attempts.
        if (error instanceof Error && error.name === "ZodError") {
          message.ack();
          return;
        }
        message.retry();
      }
  }
}

export { CLASSIFIER_ID };

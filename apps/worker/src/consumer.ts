import { CLASSIFIER_ID, contentOf } from "./classify.ts";
import { USER_AGENT } from "./feeds.ts";
import { classifyPart } from "./guesses.ts";
import { pdfium } from "./pdfium.ts";
import {
  CONVERTER,
  chunk,
  EXTRACT_MODEL,
  EXTRACTOR_ID,
  mergeReports,
  RESPONSE_SCHEMA,
  type Reported,
  SYSTEM,
} from "./reading.ts";
import { settle } from "./settle.ts";
import { parseSpecTables, TABLE_READER } from "./spec-table.ts";
import { seeDocument, seePage } from "./vision.ts";
import { partKey, type Work } from "./work.ts";

/**
 * One unit of fan-out work. Every kind writes its result to a key the producer can predict, so
 * nothing has to report back and a reader can tell a missing part from a short answer.
 *
 * A message that throws is retried by the queue and, once its attempts are spent, lands in the
 * dead-letter queue where it can be looked at. That is the behaviour the workflow version did not
 * have: there, one failing batch was caught, counted and forgotten.
 */
export async function handle(message: Work, env: Env, attempt = 1): Promise<void> {
  switch (message.kind) {
    case "classify": {
      await classifyPart(env, message);
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
          await env.ARCHIVE.put(
            partKey.converted(message.manufacturer, message.run, message.sha256),
            JSON.stringify({ ...message, error: one?.error ?? "the converter returned no text" }),
            { httpMetadata: { contentType: "application/json" } },
          );
          return;
        }
        await env.ARCHIVE.put(markdown, one.data, {
          httpMetadata: { contentType: "text/markdown" },
        });
      }
      const size = already?.size ?? (await env.ARCHIVE.head(markdown))?.size;
      await env.ARCHIVE.put(
        partKey.converted(message.manufacturer, message.run, message.sha256),
        JSON.stringify({
          sha256: message.sha256,
          url: message.url,
          key: markdown,
          characters: size ?? 0,
        }),
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
      // Converting and reading are two units, and the second only exists once the first has
      // produced something. Chaining them here is what makes the pipeline run without a caller.
      await env.WORK.send({
        kind: "extract",
        manufacturer: message.manufacturer,
        date: message.date,
        run: message.run,
        sha256: message.sha256,
        url: message.url,
        key: markdown,
      });
      return;
    }
    case "spec-table": {
      const response = await fetch(message.url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`${message.url}: HTTP ${response.status}`);
      const html = await response.text();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      // The page is archived like any other source, so a figure can be taken back to the bytes
      // it was read from even after the maker rewrites the page.
      await env.ARCHIVE.put(`archive/${sha256}`, html, {
        httpMetadata: { contentType: "text/html" },
      });
      const products = parseSpecTables(html);
      await env.ARCHIVE.put(
        partKey.reading(sha256, TABLE_READER.replace(/[^\w.-]+/g, "_")),
        `${JSON.stringify({ sha256, url: message.url, products, windows: 0, failed: 0, extractedBy: TABLE_READER })}\n`,
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
      return;
    }
    case "extract": {
      const reading = partKey.reading(message.sha256, EXTRACTOR_ID.replace(/[^\w.-]+/g, "_"));
      // Reading a document is the expensive step, and both the document and the reading are
      // addressed by content, so a reading that exists is a reading of exactly these bytes by
      // exactly this reader — whichever run asked for it.
      if (await env.ARCHIVE.head(reading)) return;
      const object = await env.ARCHIVE.get(message.key);
      if (!object) throw new Error(`${message.key} is gone`);
      const windows = chunk(await object.text()).slice(0, message.maxWindows ?? 60);
      const reports: Reported[] = [];
      let failed = 0;
      for (const window of windows) {
        try {
          const response = await env.AI.run(EXTRACT_MODEL, {
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: window.text },
            ],
            response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
            max_tokens: 3072,
          } as never);
          const parsed = JSON.parse(contentOf(response)) as { products?: Reported[] };
          if (Array.isArray(parsed.products)) {
            for (const product of parsed.products) {
              if (!Array.isArray(product?.specs)) continue;
              // The page comes from where the window started, not from the model: an invented
              // page number is worse than none, because it looks checkable.
              reports.push({
                ...product,
                specs: product.specs.map((s) => ({
                  ...s,
                  ...(window.page === undefined ? {} : { page: window.page }),
                })),
              });
            }
          }
        } catch {
          failed += 1;
        }
      }
      // Compact, one object per line. Pretty-printing meant a run read back as a concatenation
      // of multi-line objects, which is not the newline-delimited stream every reader expects.
      await env.ARCHIVE.put(
        reading,
        `${JSON.stringify({ sha256: message.sha256, url: message.url, products: mergeReports(reports), windows: windows.length, failed })}\n`,
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
      return;
    }
    case "vision": {
      await seeDocument(message, env);
      return;
    }
    case "vision-page": {
      await seePage(message, env, attempt, pdfium);
      return;
    }
  }
}

/** The queue handler: each message of the batch handled on its own (see `settle`). */
export async function consume(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await settle(batch, (work, attempt) => handle(work, env, attempt));
}

export { CLASSIFIER_ID };

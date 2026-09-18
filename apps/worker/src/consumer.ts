import { CLASSIFIER_ID } from "./classify.ts";
import { readDocument } from "./extract.ts";
import { USER_AGENT } from "./feeds.ts";
import { classifyPart } from "./guesses.ts";
import { sectionsOf, withOpenings } from "./layout.ts";
import { pdfium } from "./pdfium.ts";
import { CONVERTER, textLayer } from "./reading.ts";
import { markdownOfDocument, outlineOf, pageCount } from "./render.ts";
import { settle } from "./settle.ts";
import { parseSpecTables, TABLE_READER } from "./spec-table.ts";
import { seeDocument, seePage, seeWindow } from "./vision.ts";
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
        const bytes = new Uint8Array(await object.arrayBuffer());
        // A PDF is read from where its characters sit: a table keeps its columns, and a value stays
        // under the model it belongs to. Its headings are kept beside it, so the sections it states
        // its ratings in are known without opening the document again. A PDF of pictures has no
        // characters and gives nothing here, which is what the page reader is for.
        let text: string | undefined;
        if (/pdf/i.test(message.contentType)) {
          const library = await pdfium();
          const read = markdownOfDocument(library, bytes);
          if (textLayer(read).characters > 0) {
            text = read;
            await env.ARCHIVE.put(
              partKey.outline(message.sha256, CONVERTER),
              `${JSON.stringify(withOpenings(text, sectionsOf(outlineOf(library, bytes), pageCount(library, bytes))))}\n`,
              { httpMetadata: { contentType: "application/json" } },
            );
          }
        }
        if (text === undefined) {
          const blob = new Blob([bytes], { type: message.contentType });
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
          text = one.data;
        }
        await env.ARCHIVE.put(markdown, text ?? "", {
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
        partKey.parsed(sha256, TABLE_READER.replace(/[^\w.-]+/g, "_")),
        `${JSON.stringify({ sha256, url: message.url, products, windows: 0, failed: 0, extractedBy: TABLE_READER })}\n`,
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
      return;
    }
    case "extract": {
      await readDocument(message, env, attempt);
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
    case "vision-window": {
      await seeWindow(message, env, attempt);
      return;
    }
  }
}

/** The queue handler: each message of the batch handled on its own (see `settle`). */
export async function consume(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await settle(batch, (work, attempt) => handle(work, env, attempt));
}

export { CLASSIFIER_ID };

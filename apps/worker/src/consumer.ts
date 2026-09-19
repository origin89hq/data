import { CLASSIFIER_ID } from "./classify.ts";
import { convertDocument } from "./convert.ts";
import { readDocument } from "./extract.ts";
import { USER_AGENT } from "./feeds.ts";
import { classifyPart } from "./guesses.ts";
import { pdfium } from "./pdfium.ts";
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
      await convertDocument(message, env, pdfium);
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

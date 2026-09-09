import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { contentOf } from "./classify.ts";
import { chunk, CONVERTER, EXTRACT_MODEL, EXTRACTOR_ID, MAX_WINDOWS, RESPONSE_SCHEMA, SYSTEM, mergeReports, type Converted, type Reported } from "./reading.ts";

export interface ExtractParams {
  manufacturerId: string;
  checkedAt: string;
  /** Windows to read before stopping. Defaults to MAX_WINDOWS; the run records where it stopped. */
  maxWindows?: number;
}

/**
 * Read the ratings out of a manufacturer's converted documents. Nothing here decides anything:
 * the output is what a model says a document says, kept per document so a figure can always be
 * taken back to the page it came off.
 */
export class ExtractSpecs extends WorkflowEntrypoint<Env, ExtractParams> {
  async run(event: WorkflowEvent<ExtractParams>, step: WorkflowStep) {
    const { manufacturerId, checkedAt, maxWindows = MAX_WINDOWS } = event.payload;
    const prefix = `documents/${manufacturerId}/${checkedAt}`;

    const documents = await step.do("read the conversion index", async () => {
      const object = await this.env.ARCHIVE.get(`${prefix}/converted.json`);
      if (!object) throw new Error(`${prefix}: nothing converted yet`);
      const { documents } = (await object.json()) as { documents: Converted[] };
      return documents.filter((d) => d.key);
    });

    const perDocument: { sha256: string; url: string; products: Reported[]; windows: number; failed: number }[] = [];
    let spent = 0;
    let stoppedAt: string | undefined;
    for (const doc of documents) {
      if (spent >= maxWindows) {
        stoppedAt = doc.sha256;
        break;
      }
      const result = await step.do(
        `read ${doc.sha256.slice(0, 12)}`,
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const object = await this.env.ARCHIVE.get(doc.key!);
          if (!object) throw new Error(`${doc.key} is gone`);
          const windows = chunk(await object.text()).slice(0, Math.max(1, maxWindows - spent));
          const reports: Reported[] = [];
          let failed = 0;
          for (const window of windows) {
            try {
              const response = await this.env.AI.run(EXTRACT_MODEL, {
                messages: [{ role: "system", content: SYSTEM }, { role: "user", content: window.text }],
                response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
                max_tokens: 3072,
              } as never);
              const parsed = JSON.parse(contentOf(response)) as { products?: Reported[] };
              // The page comes from where the window started, not from the model: a page number
              // it invented would be worse than none, because it looks checkable.
              if (Array.isArray(parsed.products)) {
                for (const product of parsed.products) {
                  if (!Array.isArray(product?.specs)) continue;
                  reports.push({ ...product, specs: product.specs.map((s) => ({ ...s, ...(window.page === undefined ? {} : { page: window.page }) })) });
                }
              }
            } catch {
              // One window that will not read costs its own figures. A document is many windows
              // and losing all of them because of one is worse than reporting the gap.
              failed += 1;
            }
          }
          return { products: mergeReports(reports), windows: windows.length, failed };
        },
      );
      perDocument.push({ sha256: doc.sha256, url: doc.url, ...result });
      spent += result.windows;
    }

    const figures = perDocument.reduce((n, d) => n + d.products.reduce((m, p) => m + p.specs.length, 0), 0);
    await step.do("write the readings", async () => {
      await this.env.ARCHIVE.put(`${prefix}/specs.${EXTRACTOR_ID.replace(/[^\w.-]+/g, "_")}.json`, JSON.stringify({
        manufacturer: manufacturerId, checkedAt, converter: CONVERTER, extractedBy: EXTRACTOR_ID,
        documents: perDocument.length, ofDocuments: documents.length, windowsRead: spent, windowBudget: maxWindows,
        ...(stoppedAt ? { stoppedAtDocument: stoppedAt } : {}), figures, readings: perDocument,
      }, null, 2), { httpMetadata: { contentType: "application/json" } });
    });
    console.log(JSON.stringify({ message: "extraction finished", manufacturer: manufacturerId, documents: `${perDocument.length}/${documents.length}`, windowsRead: spent, budget: maxWindows, ...(stoppedAt ? { stoppedEarly: true } : {}), figures }));
    return { manufacturer: manufacturerId, documents: perDocument.length, ofDocuments: documents.length, windowsRead: spent, figures, stoppedEarly: Boolean(stoppedAt) };
  }
}

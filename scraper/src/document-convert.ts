import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CONVERTER, type Converted } from "./reading.ts";

export { CONVERTER } from "./reading.ts";

export interface ConvertParams {
  manufacturerId: string;
  checkedAt: string;
}

/** Documents converted per step. Conversion is a round trip through R2 and the AI binding, so keep it small. */
export const CONVERT_BATCH = 4;

/**
 * Turn the documents a manufacturer crawl archived into markdown. Nothing is fetched here: this
 * reads what a person already approved, so it cannot reach the open web at all.
 */
export class DocumentConvert extends WorkflowEntrypoint<Env, ConvertParams> {
  async run(event: WorkflowEvent<ConvertParams>, step: WorkflowStep) {
    const { manufacturerId, checkedAt } = event.payload;
    const prefix = `documents/${manufacturerId}/${checkedAt}`;

    const documents = await step.do("read the manifest", async () => {
      const object = await this.env.ARCHIVE.get(`${prefix}/manifest.json`);
      if (!object) throw new Error(`${prefix}: no manifest, so no approved download to convert`);
      const { documents } = (await object.json()) as { documents: { url: string; sha256: string; contentType: string }[] };
      return documents;
    });

    const converted: Converted[] = [];
    for (let b = 0; b * CONVERT_BATCH < documents.length; b += 1) {
      const slice = documents.slice(b * CONVERT_BATCH, (b + 1) * CONVERT_BATCH);
      const batch = await step.do(
        `convert ${b + 1} of ${Math.ceil(documents.length / CONVERT_BATCH)}`,
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const out: Converted[] = [];
          for (const doc of slice) {
            const key = `archive/${doc.sha256}.${CONVERTER}.md`;
            try {
              const existing = await this.env.ARCHIVE.head(key);
              if (existing) {
                out.push({ sha256: doc.sha256, url: doc.url, key, characters: existing.size });
                continue;
              }
              const object = await this.env.ARCHIVE.get(`archive/${doc.sha256}`);
              if (!object) throw new Error("the document is not in the archive");
              const blob = new Blob([await object.arrayBuffer()], { type: doc.contentType });
              const name = new URL(doc.url).pathname.split("/").pop() || doc.sha256;
              const result = await this.env.AI.toMarkdown({ name, blob });
              const one = Array.isArray(result) ? result[0] : result;
              if (!one || one.format === "error" || typeof one.data !== "string") throw new Error(one?.error ?? "the converter returned no text");
              await this.env.ARCHIVE.put(key, one.data, { httpMetadata: { contentType: "text/markdown" } });
              out.push({ sha256: doc.sha256, url: doc.url, key, characters: one.data.length });
            } catch (error) {
              // A document that will not convert is recorded and left. A scanned manual with no
              // text layer is a real answer, and dropping it silently would hide how much of a
              // maker's catalogue is actually readable.
              out.push({ sha256: doc.sha256, url: doc.url, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return out;
        },
      );
      converted.push(...batch);
    }

    const ok = converted.filter((c) => c.key);
    await step.do("write the conversion index", async () => {
      await this.env.ARCHIVE.put(`${prefix}/converted.json`, JSON.stringify({ manufacturer: manufacturerId, checkedAt, converter: CONVERTER, converted: ok.length, failed: converted.length - ok.length, documents: converted }, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
    });
    console.log(JSON.stringify({ message: "conversion finished", manufacturer: manufacturerId, checkedAt, converter: CONVERTER, converted: ok.length, failed: converted.length - ok.length }));
    return { manufacturer: manufacturerId, converted: ok.length, failed: converted.length - ok.length };
  }
}

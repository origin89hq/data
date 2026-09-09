import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Sighting } from "../../schema/sighting.ts";
import { classifyBatch, CLASSIFIER_ID, CLASSIFY_BATCH } from "./classify.ts";

export interface ClassifyParams {
  sellerId: string;
  checkedAt: string;
}

/**
 * Read a finished crawl back from R2 and ask the model, one batch per step, what each listing
 * is. Guesses land beside the sightings under the classifier's id, so a second model or prompt
 * writes a second set and a person can compare them.
 */
export class ClassifySightings extends WorkflowEntrypoint<Env, ClassifyParams> {
  async run(event: WorkflowEvent<ClassifyParams>, step: WorkflowStep) {
    const { sellerId, checkedAt } = event.payload;
    const source = `sightings/${sellerId}/${checkedAt}`;
    const target = `guesses/${sellerId}/${checkedAt}/${CLASSIFIER_ID.replace(/[^\w.-]+/g, "_")}`;

    const pages = await step.do("list pages", async () => {
      const manifest = await this.env.ARCHIVE.get(`${source}/manifest.json`);
      if (!manifest) throw new Error(`${source}: no manifest, the crawl did not finish`);
      const { pages } = (await manifest.json()) as { pages: { page: number }[] };
      return pages.map((p) => p.page);
    });

    let total = 0;
    let missingTotal = 0;
    for (const page of pages) {
      const key = `${source}/page-${String(page).padStart(4, "0")}.jsonl`;
      const sightings = await step.do(`read page ${page}`, async () => {
        const object = await this.env.ARCHIVE.get(key);
        if (!object) throw new Error(`${key} missing`);
        return (await object.text()).split("\n").filter(Boolean).map((line) => Sighting.parse(JSON.parse(line)));
      });
      const batches = Math.ceil(sightings.length / CLASSIFY_BATCH);
      const pageGuesses: string[] = [];
      let pageMissing: string[] = [];
      for (let b = 0; b < batches; b += 1) {
        const batch = sightings.slice(b * CLASSIFY_BATCH, (b + 1) * CLASSIFY_BATCH);
        const result = await step.do(
          `classify page ${page} batch ${b + 1}`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "linear" }, timeout: "2 minutes" },
          () => classifyBatch(this.env.AI, batch),
        );
        pageGuesses.push(...result.guesses.map((g) => JSON.stringify(g)));
        pageMissing = pageMissing.concat(result.missing);
      }
      await step.do(`write guesses page ${page}`, async () => {
        await this.env.ARCHIVE.put(`${target}/page-${String(page).padStart(4, "0")}.jsonl`, `${pageGuesses.join("\n")}\n`, {
          httpMetadata: { contentType: "application/x-ndjson" },
        });
      });
      total += pageGuesses.length;
      missingTotal += pageMissing.length;
    }
    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(`${target}/manifest.json`, JSON.stringify({ seller: sellerId, checkedAt, by: CLASSIFIER_ID, guesses: total, missing: missingTotal }, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
    });
    console.log(JSON.stringify({ message: "classification finished", seller: sellerId, checkedAt, guesses: total, missing: missingTotal }));
    return { seller: sellerId, checkedAt, guesses: total, missing: missingTotal };
  }
}

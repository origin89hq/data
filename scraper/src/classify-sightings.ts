import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Sighting } from "../../schema/sighting.ts";
import { classifyBatch, classifierKey, CLASSIFIER_ID, CLASSIFY_BATCH } from "./classify.ts";

export interface ClassifyParams {
  sellerId: string;
  checkedAt: string;
}

/**
 * Read a finished crawl back and ask the model, a batch per step, what each listing is. Guesses
 * land beside the sightings under the classifier's id, so a second model or prompt writes a
 * second set and a person can compare them. A batch the model cannot answer is counted and
 * skipped: one bad answer must not cost the other two thousand listings.
 */
export class ClassifySightings extends WorkflowEntrypoint<Env, ClassifyParams> {
  async run(event: WorkflowEvent<ClassifyParams>, step: WorkflowStep) {
    const { sellerId, checkedAt } = event.payload;
    const source = `sightings/${sellerId}/${checkedAt}`;
    const target = `guesses/${sellerId}/${checkedAt}/${classifierKey()}`;

    const pages = await step.do("list pages", async () => {
      const manifest = await this.env.ARCHIVE.get(`${source}/manifest.json`);
      if (!manifest) throw new Error(`${source}: no manifest, the crawl did not finish`);
      const { pages } = (await manifest.json()) as { pages: { page: number }[] };
      return pages.map((p) => p.page);
    });

    let guessed = 0;
    let unanswered = 0;
    for (const page of pages) {
      const key = `${source}/page-${String(page).padStart(4, "0")}.jsonl`;
      const sightings = await step.do(`read page ${page}`, async () => {
        const object = await this.env.ARCHIVE.get(key);
        if (!object) throw new Error(`${key} missing`);
        return (await object.text()).split("\n").filter(Boolean).map((line) => Sighting.parse(JSON.parse(line)));
      });

      const lines: string[] = [];
      const batches = Math.ceil(sightings.length / CLASSIFY_BATCH);
      for (let b = 0; b < batches; b += 1) {
        const batch = sightings.slice(b * CLASSIFY_BATCH, (b + 1) * CLASSIFY_BATCH);
        try {
          const guesses = await step.do(
            `classify page ${page} batch ${b + 1}`,
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
            () => classifyBatch(this.env.AI, batch),
          );
          lines.push(...guesses.map((g) => JSON.stringify(g)));
        } catch (error) {
          unanswered += batch.length;
          console.error(JSON.stringify({ message: "batch unanswered", seller: sellerId, page, batch: b + 1, size: batch.length, error: error instanceof Error ? error.message : String(error) }));
        }
      }

      if (lines.length > 0) {
        await step.do(`write guesses page ${page}`, async () => {
          await this.env.ARCHIVE.put(`${target}/page-${String(page).padStart(4, "0")}.jsonl`, `${lines.join("\n")}\n`, {
            httpMetadata: { contentType: "application/x-ndjson" },
          });
        });
      }
      guessed += lines.length;
    }

    await step.do("write manifest", async () => {
      await this.env.ARCHIVE.put(`${target}/manifest.json`, JSON.stringify({ seller: sellerId, checkedAt, by: CLASSIFIER_ID, guesses: guessed, unanswered }, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
    });
    console.log(JSON.stringify({ message: "classification finished", seller: sellerId, checkedAt, guesses: guessed, unanswered }));
    return { seller: sellerId, checkedAt, guesses: guessed, unanswered };
  }
}

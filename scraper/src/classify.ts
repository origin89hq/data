import { EquipmentKind, Guess } from "../../schema/guess.ts";
import type { Sighting } from "../../schema/sighting.ts";

/** Pinned so a guess can say exactly what produced it. Bump the prompt version when the prompt changes. */
export const CLASSIFIER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const PROMPT_VERSION = "1";
export const CLASSIFIER_ID = `ai:${CLASSIFIER_MODEL}@p${PROMPT_VERSION}`;

/** How many sightings go into one model call. Enough to amortise the prompt, few enough that a bad answer costs little. */
export const CLASSIFY_BATCH = 20;

const SYSTEM = `You classify product listings from off-grid energy retailers. For each listing decide:
- kind: one of ${EquipmentKind.options.join(", ")}. Use "out-of-scope" for anything that is not electrical energy equipment (stoves, toilets, cookware, clothing, plumbing, tools, cables and connectors count as "balance-of-system" only when they are electrical). Portable power stations are "inverter-charger". Solar generators kits with panels are "inverter-charger".
- model: the manufacturer's model number as printed in the title or SKU, e.g. "XTRA4210N", "SmartSolar MPPT 100/30", "S-550". Omit it when the title carries no model number.
- manufacturer: the company that makes the product, which may differ from the brand string a reseller prints (e.g. brand "The Cabin Depot" on a Rolls battery is Rolls). Omit it when unsure.
Answer only from the listing text. Do not invent model numbers.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string" },
          kind: { type: "string", enum: EquipmentKind.options },
          model: { type: "string" },
          manufacturer: { type: "string" },
        },
        required: ["productId", "kind"],
      },
    },
  },
  required: ["items"],
};

interface RawItem {
  productId: string;
  kind: string;
  model?: string;
  manufacturer?: string;
}

/** One listing per line, only the fields that carry signal. The description is deliberately absent: it is long and it lies. */
export function promptFor(batch: Sighting[]): string {
  return batch
    .map((s) => {
      const parts = [`id=${s.productId}`, `title="${s.title}"`];
      if (s.brand) parts.push(`brand="${s.brand}"`);
      if (s.sku) parts.push(`sku="${s.sku}"`);
      if (s.model) parts.push(`model="${s.model}"`);
      if (s.category) parts.push(`category="${s.category}"`);
      if (s.variant) parts.push(`variant="${s.variant}"`);
      return parts.join(" ");
    })
    .join("\n");
}

/**
 * Turn the model's answer into guesses, refusing anything it made up: an id not in the batch, a
 * kind outside the enum, or an empty string where absence was meant. Every batch item gets a
 * row; an item the model skipped is reported as missing so the caller can decide.
 */
export function guessesFrom(batch: Sighting[], raw: unknown): { guesses: Guess[]; missing: string[] } {
  const byId = new Map(batch.map((s) => [s.productId, s]));
  const items = (raw as { items?: RawItem[] })?.items ?? [];
  const guesses: Guess[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const s = byId.get(String(item.productId));
    if (!s || seen.has(s.productId)) continue;
    const kind = EquipmentKind.safeParse(item.kind);
    if (!kind.success) continue;
    seen.add(s.productId);
    guesses.push(
      Guess.parse({
        seller: s.seller,
        productId: s.productId,
        kind: kind.data,
        ...(item.model?.trim() ? { model: item.model.trim() } : {}),
        ...(item.manufacturer?.trim() ? { manufacturer: item.manufacturer.trim() } : {}),
        by: CLASSIFIER_ID,
      }),
    );
  }
  const missing = batch.filter((s) => !seen.has(s.productId)).map((s) => s.productId);
  return { guesses, missing };
}

/** One model call for one batch. Throws on a malformed answer so the step retries. */
export async function classifyBatch(ai: Ai, batch: Sighting[]): Promise<{ guesses: Guess[]; missing: string[] }> {
  const response = (await ai.run(CLASSIFIER_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: promptFor(batch) },
    ],
    response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    max_tokens: 4096,
  } as never)) as unknown as { response?: unknown };
  const raw = typeof response.response === "string" ? JSON.parse(response.response) : response.response;
  return guessesFrom(batch, raw);
}

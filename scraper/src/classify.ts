import { EquipmentKind, Guess } from "../../schema/guess.ts";
import type { Sighting } from "../../schema/sighting.ts";

/** Pinned so a guess can say exactly what produced it. Bump the prompt version when the prompt changes. */
export const CLASSIFIER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const PROMPT_VERSION = "2";
export const CLASSIFIER_ID = `ai:${CLASSIFIER_MODEL}@p${PROMPT_VERSION}`;

/** The classifier's id as a key segment: an R2 key cannot carry the slashes and @ of a model name. */
export function classifierKey(id = CLASSIFIER_ID): string {
  return id.replace(/[^\w.-]+/g, "_");
}

const SYSTEM = `You classify product listings from off-grid energy retailers.

Answer with one item per listing, in the same order as the numbered listings, and exactly as many items as there are listings. Never merge, skip or reorder listings.

For each listing give:
- kind: one of ${EquipmentKind.options.join(", ")}. Use "out-of-scope" for anything that is not electrical energy equipment: wood stoves, toilets, cookware, clothing, plumbing, furniture, tools, food. Electrical wiring, breakers, fuses, busbars and connectors are "balance-of-system". A portable power station or all-in-one solar generator is "inverter-charger".
- model: the manufacturer's model number as printed, e.g. "XTRA4210N", "SmartSolar MPPT 100/30", "S-550". Omit it when the listing carries no model number. Never invent one.
- manufacturer: the company that makes the product, which may differ from the brand a reseller prints. Omit it when unsure.

Answer only from the listing text.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: EquipmentKind.options },
          model: { type: "string" },
          manufacturer: { type: "string" },
        },
        required: ["kind"],
      },
    },
  },
  required: ["items"],
};

interface RawItem {
  kind?: string;
  model?: string;
  manufacturer?: string;
}

/**
 * One numbered listing per line, only the fields that carry signal. The description is
 * deliberately absent: it is long, it is marketing, and it pushes the batch out of the window.
 */
export function promptFor(batch: Sighting[]): string {
  return batch
    .map((s, i) => {
      const parts = [`${i + 1}.`, `title="${s.title}"`];
      if (s.brand) parts.push(`brand="${s.brand}"`);
      if (s.sku) parts.push(`sku="${s.sku}"`);
      if (s.model) parts.push(`model="${s.model}"`);
      if (s.category) parts.push(`category="${s.category}"`);
      if (s.variant) parts.push(`variant="${s.variant}"`);
      return parts.join(" ");
    })
    .join("\n");
}

/** A model that answers with the wrong number of items has lost track of which listing is which. */
export class BatchMisalignedError extends Error {
  readonly expected: number;
  readonly received: number;
  constructor(expected: number, received: number) {
    super(`model answered ${received} items for ${expected} listings`);
    this.expected = expected;
    this.received = received;
  }
}

/**
 * Match answers to listings by position, which is the only mapping a model gets right: asked to
 * echo an id it invents one ("A1", "I001") and every guess would be silently dropped. A wrong
 * item count means the alignment is gone, so nothing is written rather than everything shifted.
 */
export function guessesFrom(batch: Sighting[], raw: unknown): Guess[] {
  const items = (raw as { items?: RawItem[] })?.items;
  if (!Array.isArray(items)) throw new BatchMisalignedError(batch.length, 0);
  if (items.length !== batch.length) throw new BatchMisalignedError(batch.length, items.length);
  return batch.map((s, i) => {
    const item = items[i] ?? {};
    const kind = EquipmentKind.safeParse(item.kind);
    return Guess.parse({
      seller: s.seller,
      productId: s.productId,
      kind: kind.success ? kind.data : "out-of-scope",
      ...(kind.success ? {} : { unreadable: true }),
      ...(item.model?.trim() ? { model: item.model.trim() } : {}),
      ...(item.manufacturer?.trim() ? { manufacturer: item.manufacturer.trim() } : {}),
      by: CLASSIFIER_ID,
    });
  });
}

/** Workers AI answers OpenAI-style for chat models and `{response}` for others. Read both, refuse anything else. */
export function contentOf(response: unknown): string {
  const r = response as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  const content = typeof r?.response === "string" ? r.response : r?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("model returned no text");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  return (fenced ? fenced[1] : content).trim();
}

/** One model call for one batch. Throws on a malformed or misaligned answer so the step retries. */
export async function classifyBatch(ai: Ai, batch: Sighting[]): Promise<Guess[]> {
  const response = await ai.run(CLASSIFIER_MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: promptFor(batch) },
    ],
    response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    max_tokens: 2048,
  } as never);
  return guessesFrom(batch, JSON.parse(contentOf(response)));
}

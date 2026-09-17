import { GATE_ID } from "@origin89/equipment-schema/provenance";
import { z } from "zod";
import { answerText } from "./classify.ts";
import { answerObjects, EXTRACT_MODEL } from "./reading.ts";
import { readerKey, type Work } from "./work.ts";

/**
 * The document gate: a converted document is sorted by kind before its figures are read. A maker
 * publishes more than ratings of its own products, and a reader told to leave the rest out still
 * read it. In the figures pull #196 a certification report of battery-and-inverter systems gave
 * 1,623 figures, twenty-one compatibility notes gave the partner batteries they cover, and training
 * decks, safety data sheets and settings templates gave the rest. Sorted by Kimi from the start of
 * each document, the kinds below held 105 of the wrong figures in a sampled 539 and 7 right ones.
 */

type ExtractMessage = Extract<Work, { kind: "extract" }>;

export const DOCUMENT_KINDS = [
  "datasheet",
  "manual",
  "catalog",
  "brochure",
  "compatibility-note",
  "certificate-or-test-report",
  "safety-data-sheet",
  "installation-guide",
  "training-or-presentation",
  "selector-guide",
  "letter-or-regulatory",
  "case-study",
  "settings-template",
  "other",
] as const;

/** Kinds that state no ratings of the maker's own products, whatever their pages print. */
const NOT_RATINGS: ReadonlySet<string> = new Set([
  "compatibility-note",
  "certificate-or-test-report",
  "safety-data-sheet",
  "training-or-presentation",
  "letter-or-regulatory",
  "case-study",
  "settings-template",
]);

export const DocumentKind = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  ownRatings: z.boolean(),
  reason: z.string(),
});
export type DocumentKind = z.infer<typeof DocumentKind>;

/**
 * Whether a document is left unread. A selector guide is read when it rates the maker's own
 * products, as a model-number guide does, and left when it matches products to another company's
 * equipment.
 */
export const leftUnread = (sorted: DocumentKind): boolean =>
  NOT_RATINGS.has(sorted.kind) || (sorted.kind === "selector-guide" && !sorted.ownRatings);

export const GATE_SYSTEM = `You sort a manufacturer's documents before their figures are read. The message gives the maker, the document's address and the start of its text. Say what kind of document it is, and whether it states rated figures of the maker's own products.

Kinds: "datasheet" (a spec or data sheet); "manual" (an owner's, user or installation manual that gives the product's specifications); "catalog" (several products with their specifications); "brochure" (marketing that gives specifications); "compatibility-note" (how the maker's product works with another company's product: integration guides, compatibility notes, settings for another company's battery); "certificate-or-test-report" (a certificate, listing, test report or declaration of conformity); "safety-data-sheet" (an MSDS or SDS); "installation-guide" (installation, mounting or wiring instructions or tips that do not give the product's ratings); "training-or-presentation" (slides, training material, program briefings); "selector-guide" (which product to choose for an application or for another company's equipment); "letter-or-regulatory" (letters, filings, approvals); "case-study"; "settings-template" (a switch or configuration worksheet); "other".

ownRatings is true only when the document itself states rated figures of the maker's own products. Reply with JSON only: {"kind":"...","ownRatings":true,"reason":"one short sentence"}.`;

const GATE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: DOCUMENT_KINDS },
    ownRatings: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["kind", "ownRatings", "reason"],
};

/** How much of a document the gate is shown: its first pages, from the first page marker on. */
const SHOWN = 8000;

/** The gate's message: the maker, the document's address, and the start of its text past its metadata. */
export function gatePrompt(maker: string, url: string, markdown: string): string {
  const firstPage = markdown.search(/^#{1,6}\s*Page\s+1\s*$/m);
  let address = url;
  try {
    address = decodeURIComponent(url);
  } catch {
    // An address that does not decode is shown as it was given.
  }
  return `Maker: ${maker}\nAddress: ${address}\n\n${markdown.slice(Math.max(0, firstPage), Math.max(0, firstPage) + SHOWN)}`;
}

/**
 * The kind of a document, keyed as its readings are: whether it states the maker's own ratings
 * depends on the maker it is sorted for.
 */
export const gateKey = (sha256: string, maker: string): string =>
  `archive/${sha256}.${maker}.${readerKey(GATE_ID)}.kind.json`;

/** The kind a document was sorted into for this maker before, if it was. */
export async function keptKind(
  env: Env,
  sha256: string,
  maker: string,
): Promise<DocumentKind | undefined> {
  const kept = await env.ARCHIVE.get(gateKey(sha256, maker));
  if (!kept) return undefined;
  const parsed = DocumentKind.safeParse(await kept.json());
  return parsed.success ? parsed.data : undefined;
}

/**
 * Sort a document by kind with one model call, and keep the answer beside it, so a delivery that
 * reads the document again does not ask again. Throws what the call throws, for the reader to wait
 * its turn or retry.
 */
export async function sortDocument(
  env: Env,
  message: ExtractMessage,
  maker: string,
  markdown: string,
): Promise<DocumentKind> {
  const response = await env.AI.run(EXTRACT_MODEL, {
    messages: [
      { role: "system", content: GATE_SYSTEM },
      { role: "user", content: gatePrompt(maker, message.url, markdown) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "document", schema: GATE_SCHEMA, strict: false },
    },
    chat_template_kwargs: { thinking: false },
    max_tokens: 400,
  } as never);
  const sorted = DocumentKind.parse(answerObjects(answerText(response))[0]);
  await env.ARCHIVE.put(
    gateKey(message.sha256, message.manufacturer),
    `${JSON.stringify(sorted)}\n`,
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  return sorted;
}

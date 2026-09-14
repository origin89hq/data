import type { Spec } from "@origin89/equipment-schema/model";
import type { Rejection, Rejections } from "@origin89/equipment-schema/rejection";
import { sameName } from "./specs.ts";

/** A printed name as a rejection matches it: whole, ignoring case and spacing. */
const spoken = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/** One maker's rejections, or none when nobody has rejected anything of theirs. */
export function rejectionsOf(files: readonly Rejections[], manufacturer: string): Rejection[] {
  return files.find((file) => file.id === manufacturer)?.rejections ?? [];
}

/** Whether a person rejected a whole document, so nothing it gives is read into the records. */
export function rejectsDocument(rejections: readonly Rejection[], source: string): boolean {
  return rejections.some(
    (r) => r.product === undefined && r.name === undefined && r.source === source,
  );
}

/** Whether a person rejected a figure: the whole document it came from, or it by model and name. */
export function rejectsFigure(
  rejections: readonly Rejection[],
  figure: Pick<Spec, "source" | "model" | "name">,
): boolean {
  return rejections.some(
    (r) =>
      r.product === undefined &&
      r.source === figure.source &&
      (r.name === undefined ||
        (r.model === figure.model && spoken(r.name) === spoken(figure.name))),
  );
}

/** Whether a person rejected a product name, through punctuation and case, so it is never minted. */
export function rejectsProduct(rejections: readonly Rejection[], name: string): boolean {
  return rejections.some((r) => r.product !== undefined && sameName(r.product, name));
}

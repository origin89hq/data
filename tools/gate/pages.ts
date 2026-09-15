import { asciiSymbols, chunk, printedPage } from "../../apps/worker/src/reading.ts";
import type { ReportedProduct } from "../../src/specs.ts";

/*
 * The page each figure of a text reading is printed on, looked up again in the windows the reader
 * was shown. A reading made before #152 cites the page its window starts on, and nothing at all when
 * the window starts in the converter's title and metadata, before the first page heading (#182).
 * The converted text is kept beside the document, and since #42 so is each window's answer, so the
 * pages can be put right without reading the document again.
 */

/** One window of a text reading as the Worker keeps it beside the document. */
export interface KeptWindow {
  /** Counted from one, in the order `chunk` cuts the converted text. */
  window: number;
  products: unknown[];
}

/** What the lookup did to a reading's figures. */
export interface PageCounts {
  /** Figures that had no page and now cite the one their value is printed on. */
  set: number;
  /** Figures that cited another page and now cite the one their value is printed on. */
  moved: number;
  /** Figures that already cited the page their value is printed on. */
  kept: number;
  /** Figures whose value and name are printed in none of their windows, left with the page they had. */
  unfound: number;
}

export const noPages = (): PageCounts => ({ set: 0, moved: 0, kept: 0, unfound: 0 });

/** A figure as `mergeReports` tells one from another: its product, name, value and conditions. */
const figureKey = (
  model: string,
  figure: { name: string; value: string; conditions?: string | undefined },
): string =>
  [
    model.trim().toLowerCase(),
    figure.name.trim().toLowerCase(),
    figure.value.trim(),
    (figure.conditions ?? "").trim().toLowerCase(),
  ].join("|");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A reading's products with each figure citing the page its value is printed on. The windows are
 * cut again from the converted text exactly as the reader cut them, and a figure is looked up in
 * each window that reported it, first to last, as it was shown to the reader: the page is the first
 * one found. A figure found in none keeps the page it had, so this never takes a page away.
 *
 * A reading made before #42 kept no windows. It was also made before #152, so each of its figures
 * cites the page its window starts on, or none for a window that starts before the first page
 * heading, and is looked up in the windows that start there.
 */
export function printedPages(
  products: readonly ReportedProduct[],
  markdown: string,
  windows: readonly KeptWindow[],
): { products: ReportedProduct[]; counts: PageCounts } {
  const shown = chunk(markdown).map((window) => ({ ...window, text: asciiSymbols(window.text) }));
  const lookUp = (window: (typeof shown)[number], figure: { name: string; value: string }) =>
    printedPage(window, { name: asciiSymbols(figure.name), value: asciiSymbols(figure.value) });
  const found = new Map<string, number>();
  for (const part of [...windows].sort((a, b) => a.window - b.window)) {
    const window = Number.isInteger(part.window) ? shown[part.window - 1] : undefined;
    if (!window) continue;
    for (const product of part.products) {
      if (!isRecord(product) || typeof product.model !== "string") continue;
      if (!Array.isArray(product.specs)) continue;
      for (const spec of product.specs as unknown[]) {
        if (!isRecord(spec) || typeof spec.name !== "string" || typeof spec.value !== "string")
          continue;
        const key = figureKey(product.model, {
          name: spec.name,
          value: spec.value,
          conditions: typeof spec.conditions === "string" ? spec.conditions : undefined,
        });
        if (found.has(key)) continue;
        const page = lookUp(window, { name: spec.name, value: spec.value });
        if (page !== undefined) found.set(key, page);
      }
    }
  }
  const counts = noPages();
  const repaired = products.map((product) => ({
    ...product,
    specs: product.specs.map((spec) => {
      const page =
        windows.length > 0
          ? found.get(figureKey(product.model, spec))
          : shown
              .filter((window) => window.page === spec.page)
              .map((window) => lookUp(window, spec))
              .find((at) => at !== undefined);
      if (page === undefined) {
        counts.unfound += 1;
        return spec;
      }
      if (spec.page === undefined) counts.set += 1;
      else if (spec.page === page) counts.kept += 1;
      else counts.moved += 1;
      return { ...spec, page };
    }),
  }));
  return { products: repaired, counts };
}

import { looksLikeModelName } from "./models.ts";

/** What discovery reports about one page it fetched and found a table on. */
export interface Candidate {
  url: string;
  products: number;
  figures: number;
  withUnit: number;
  models: string[];
}

/** How much a page has to state before it is worth reading for figures. */
export interface Bar {
  minFigures: number;
  minWithUnit: number;
}

/**
 * A page whose path says article, guide or dated post. Bluetti's eight best-scoring candidates were
 * all of this shape, and the top one carried 128 figures with units — real numbers, in a table, about
 * real products, and still the wrong source: a buying guide is somebody writing about equipment, not
 * the maker stating its specification. One of them named a product "Why This Matters to You".
 */
const ARTICLE = /\/(blogs?|articles?|news|guides?|buying-guide|learn|resources?|stories)\//i;

/** A WordPress dated permalink — /2016/07/07/... — which is a post whatever the section is called. */
const DATED_POST = /\/(19|20)\d{2}\/\d{1,2}\/\d{1,2}\//;

/**
 * Why this page should not be adopted, or undefined when it should be.
 *
 * The model check is the strict one: every name in the header row has to look like a model, not most
 * of them. A row reading "Switch Function, Position: 0, Position: 1" is a DIP-switch chart and a row
 * reading "2 Amp-Hours, 25.6 Watt-Hours, GENIUS1" is a spec row that got parsed as headers — in both
 * cases the figures underneath are real numbers filed under the wrong thing, which is worse than no
 * figures at all.
 */
export function refuses(page: Candidate, bar: Bar): string | undefined {
  const path = new URL(page.url).pathname;
  if (ARTICLE.test(path)) return "an article rather than a specification";
  if (DATED_POST.test(path)) return "a dated post rather than a specification";
  if (page.figures < bar.minFigures) return `only ${page.figures} figures`;
  if (page.withUnit < bar.minWithUnit) return `only ${page.withUnit} figures carry a unit`;
  const notAModel = page.models.find((name) => !looksLikeModelName(name));
  if (notAModel !== undefined)
    return `its table is headed ${JSON.stringify(notAModel)}, which is not a model`;
  return undefined;
}

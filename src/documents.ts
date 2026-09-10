/**
 * Which language a document is written in, when its own file name says so.
 *
 * Sol-Ark publishes the 8K manual twice, as `..._UserManual_v1.0_ES_...pdf` and
 * `...-8K-2P-N-EN-Manual...pdf`, and reading both gave that inverter a nominal voltage of 48 V
 * under "Nominal system voltage" and again under "Voltaje nominal". The figures were right and the
 * dataset still counted the product twice, which is the shape of the whole problem: a translation
 * is the same specification said again, so it is not a second source.
 */

/** The languages seen in these makers' file names. Deliberately short: a guess here drops a document. */
const LANGUAGES = ["es", "fr", "pt", "it", "nl", "zh", "ja", "ko", "ru", "pl", "sv", "tr"] as const;

/** Delimited, so "Manual-ES-1.pdf" matches and "GENESIS.pdf" does not. */
const tokenIn = (name: string, token: string): boolean =>
  new RegExp(`(?:^|[-_. ])${token}(?:[-_][A-Za-z]{2})?(?:$|[-_. ])`, "i").test(name);

/**
 * The language a document's file name declares, or undefined when it declares none. A file naming
 * English as well — `GB10_Userguide_EN_ES_10.20.2022.pdf` is one bilingual guide — is not a
 * translation of anything, so it declares nothing.
 */
export function declaredLanguage(url: string): string | undefined {
  let name: string;
  try {
    name = new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return undefined;
  }
  name = name.replace(/\.[A-Za-z0-9]+$/, "");
  if (tokenIn(name, "en")) return undefined;
  return LANGUAGES.find((language) => tokenIn(name, language));
}

/**
 * The documents worth reading, with a translation dropped when the maker also publishes something
 * not marked as one. A maker who publishes only in French keeps every document it has: the choice
 * is between one language and two, never between a language and nothing.
 */
export function withoutTranslations<T extends { url: string }>(documents: T[]): { keep: T[]; dropped: { url: string; language: string }[] } {
  const translated = documents.map((document) => ({ document, language: declaredLanguage(document.url) }));
  const anyUntranslated = translated.some((row) => row.language === undefined);
  if (!anyUntranslated) return { keep: documents, dropped: [] };
  return {
    keep: translated.filter((row) => row.language === undefined).map((row) => row.document),
    dropped: translated.filter((row) => row.language !== undefined).map((row) => ({ url: row.document.url, language: row.language as string })),
  };
}

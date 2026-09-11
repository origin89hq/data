/**
 * The one rule for deciding whether two names mean one product, written once so the build, the
 * dialect linker and the API resolve names the same way (#83).
 *
 * A part of a key is the text in Unicode NFKC form, lower case, with every space and dash gone.
 * NFKC so a full-width "ＭＰＰＴ" and a ligature "ﬁ" meet their plain spellings; case, spaces and
 * dashes dropped because shops, sheets and photos disagree on exactly those. Nothing else is
 * dropped: "4,210,052,841" and "4210052841" are two keys, and a slash in "150/35" stays.
 *
 * A model key is the maker's part followed by the name's part. The maker's own name at the front
 * of a model name is not part of the name ("EG4 6000XP" under EG4 Electronics is its 6000XP), so
 * that prefix is taken off before the parts are joined. A key that reaches two models stays
 * ambiguous; nothing here breaks the tie.
 */

/** One part of a key: NFKC, lower case, spaces and dashes removed. */
export function keyPart(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(SPACES_AND_DASHES, "");
}

const SPACES_AND_DASHES = /[\s­‐-―−-]+/gu;

/** A maker's name without a trailing parenthetical: "EPEver (Beijing Epsolar Technology)" is EPEver. */
const shortName = (maker: string): string => maker.replace(/\s*\(.*\)\s*$/u, "").trim();

/**
 * The name's part of a key: the model name with the maker's own name taken off its front. The
 * maker's name is tried whole and then word by word from the left, longest first, so "EG4
 * Electronics 6000XP", "EG4 6000XP" and "6000XP" give one part; a prefix shorter than three
 * characters is left alone, since "S-550" does not start with a maker called "S".
 */
export function nameKey(maker: string, name: string): string {
  const part = keyPart(name);
  const words = shortName(maker)
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (let n = words.length; n > 0; n -= 1) {
    const prefix = words.slice(0, n).join("");
    if (prefix.length >= 3 && part.length > prefix.length && part.startsWith(prefix))
      return part.slice(prefix.length);
  }
  return part;
}

/** The maker's part of a key. */
export function makerKey(maker: string): string {
  return keyPart(shortName(maker));
}

/** The key of one product under one maker's or brand's name. */
export function modelKey(maker: string, name: string): string {
  return makerKey(maker) + nameKey(maker, name);
}

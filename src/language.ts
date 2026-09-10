/**
 * Whether a document is written in English, judged from the figure names it produced.
 *
 * The file name is not enough. Pentair marks a Spanish manual `_SPA_` in one place and `-s-` in
 * another, and its solar drive manual carries English, Spanish and French in one PDF under a name
 * that says nothing at all. Chasing each maker's convention is a list that is always one maker out
 * of date, so the evidence used here is what the document actually said.
 *
 * The test is a letter English does not use, or a Romance function word standing alone. On its own that is a poor judge of one name —
 * "Voltaje nominal" carries no accent — and a good judge of a hundred, which is the only question
 * asked of it: not what language a figure is in, but whether a document is a translation.
 */

/** Letters English does not use. Enough for the Romance languages, Hungarian and Polish seen here. */
const ACCENTED = /[áàâäéèêëíìîïóòôöúùûüñçőűąćęłńśźżÁÀÂÄÉÈÊËÍÌÎÏÓÒÔÖÚÙÛÜÑÇŐŰĄĆĘŁŃŚŹŻ]/;

/**
 * A Romance function word standing alone. Accents alone are not enough: "Capacidad de sobrecarga
 * (100 ms sobreintensidad)" is Spanish and carries none, and it published as though it were
 * English. Every one of the 299 names this catches in the records is genuinely Spanish, French or
 * Portuguese, and none of the 27 that also contain an English technical word is English — they are
 * French cognates like "Type de batterie" and "Courant de charge maximum".
 */
const ROMANCE = /(^|[\s(])(de|del|la|las|los|el|du|des|le|les|pour|avec|sans|da|dos|das|di|della|dello|delle|nel|en|por|para)([\s)]|$)/i;

/**
 * Words that name a quantity in Spanish, French or Portuguese and in no English specification.
 *
 * The two rules above still let a one-word name through. An OutBack FLEXmax published its case
 * dimensions as "Altura", "Ancho" and "Altura con ventilador", none of which carries an accent or
 * a function word. Every entry here was taken from a name in the records and checked against the
 * English ones: nothing that collides with English is on the list, which is why "motor", "phase",
 * "charge", "tension", "dimensions" and "altitude" are absent though their cognates appear.
 */
const FOREIGN_TERMS = new Set([
  // Spanish
  "altura", "anchura", "ancho", "largo", "longitud", "profundidad", "peso", "voltaje", "voltios",
  "vatios", "amperaje", "amperios", "corriente", "potencia", "frecuencia", "fase", "capacidad",
  "cilindrada", "arranque", "gasolina", "propano", "aceite", "tanque", "combustible", "ruido",
  "humedad", "salida", "entrada", "bateria", "descarga", "eficiencia", "rendimiento", "velocidad",
  "medidas", "continuos", "encendido", "marca", "modelo", "presion", "sonido", "consumo",
  // French
  "hauteur", "largeur", "longueur", "profondeur", "poids", "courant", "puissance", "pression",
  "sortie", "batterie", "essence", "huile", "carburant", "bruit", "garantie", "taille", "vitesse",
  "plage", "niveau", "rendement", "tuyau", "sel", "chute",
  // Portuguese
  "largura", "comprimento", "tensao", "frequencia", "capacidade", "partida", "oleo", "combustivel",
  "tamanho", "pressao", "umidade", "saida", "peso_pt",
]);

/** The name's words, lowercased and stripped of accents, so "Presión" and "presion" are one word. */
const wordsOf = (name: string): string[] =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);

/** Whether this name reads as something other than English. */
export function looksForeign(name: string): boolean {
  if (ACCENTED.test(name) || ROMANCE.test(name)) return true;
  return wordsOf(name).some((word) => FOREIGN_TERMS.has(word));
}

/** The share of these names carrying such a letter, between 0 and 1. No names is no evidence. */
export function foreignShare(names: readonly string[]): number {
  if (names.length === 0) return 0;
  return names.filter(looksForeign).length / names.length;
}

/** Below this many figures a document is no evidence about the language its maker publishes in. */
const ENOUGH_TO_JUDGE = 4;

/**
 * The readings worth keeping, with a maker's translated edition dropped.
 *
 * A document is a translation when most of what it states is not in English and the same maker has
 * documents that are. That is the whole test: a maker who publishes only in French keeps every
 * document, because the choice there is between a language and nothing rather than between one
 * language and two.
 */
export function withoutTranslatedReadings<T>(
  readings: readonly T[],
  namesOf: (reading: T) => string[],
  threshold = 0.5,
): { keep: T[]; dropped: T[] } {
  const rows = readings.map((reading) => {
    const names = namesOf(reading);
    return { reading, share: foreignShare(names), judged: names.length >= ENOUGH_TO_JUDGE };
  });
  const anyEnglish = rows.some((row) => row.judged && row.share <= threshold);
  if (!anyEnglish) return { keep: [...readings], dropped: [] };
  const isTranslation = (row: (typeof rows)[number]) => row.judged && row.share > threshold;
  return {
    keep: rows.filter((row) => !isTranslation(row)).map((row) => row.reading),
    dropped: rows.filter(isTranslation).map((row) => row.reading),
  };
}

/**
 * The figures worth keeping once a maker's whole set is in hand.
 *
 * A multilingual manual states a figure in each of its languages, and the English section is
 * usually read as well, so the foreign row is the same product described twice. Where a model
 * already has figures in English, a foreign-named one carrying no English name is that repeat and
 * goes. Where a model has nothing else, it stays: an untranslated label beats no model at all,
 * and it is reported so somebody can add the name to the table.
 */
export function withoutRedundantTranslations<T extends { model: string; name: string; english?: string }>(
  specs: readonly T[],
): { keep: T[]; dropped: T[]; kept: T[] } {
  const hasEnglish = new Set<string>();
  for (const spec of specs) if (!looksForeign(spec.name)) hasEnglish.add(spec.model);
  const redundant = (spec: T) => looksForeign(spec.name) && !spec.english && hasEnglish.has(spec.model);
  const orphaned = (spec: T) => looksForeign(spec.name) && !spec.english && !hasEnglish.has(spec.model);
  return {
    keep: specs.filter((spec) => !redundant(spec)),
    dropped: specs.filter(redundant),
    kept: specs.filter(orphaned),
  };
}

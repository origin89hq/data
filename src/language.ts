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
  "tamanho", "pressao", "umidade", "saida",
  // German, Dutch, Danish, Norwegian, Swedish, Finnish, Polish, Hungarian. NOCO and Champion
  // publish one manual in eight languages, and none of the rules above can see a word like
  // "Spannung" or "Lagringstemperatur": no accent, no Romance function word, one token.
  "spannung", "sicherung", "gewicht", "abmessungen", "arbeitsstrom", "arbeitszyklus",
  "betriebstemperatur", "lagertemperatur", "motorleistung", "anzahl", "zylinder", "luftstrom",
  "spanning", "afmetingen", "koeling", "opslagtemperatuur", "werkingstemperatuur", "aantal",
  "cilinders", "behuizing", "bescherming", "activiteitscyclus", "motorclassificatie", "stroomverbruik",
  "luchtstroom", "beskyttelse", "beskyttelseshus", "opbevaringstemperatur", "driftstemperatur",
  "arbejdscyklus", "arbejdsstrom", "sikring", "dimensioner", "antal", "cylindre", "luftflow",
  "motorklassificering", "lagringstemperatur", "deksel", "spaending", "kotelon", "suojaus",
  "lagringstemperatuur", "mitat", "sulake", "sylinterien", "moottorin", "pulssisuhde", "manuaalitilan",
  "lumenit", "koeling", "kolning", "bezpiecznik", "obudowa", "ochronna", "przechowywania", "robocza",
  "silnika", "lumeny", "cykl", "pracy", "munkaciklus", "temperatura", "maks",
]);

/** The name's words, lowercased and stripped of accents, so "Presión" and "presion" are one word. */
const wordsOf = (name: string): string[] =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);

/**
 * Stems that appear inside a compound and never inside an English word.
 *
 * A word list cannot win against German. "Spannung" is on it, and the records also hold
 * "Batteriespannungsbereich", "Minimale Betriebsspannung" and "Max. Solarmodul-Leerlaufspannung".
 * These are matched anywhere in the name, which is why the list is short and every entry was
 * checked against every English figure name in the records: "temperatur" is absent because it sits
 * inside "temperature", and that one substring would have flagged a thousand English rows.
 */
const FOREIGN_STEMS = [
  "spannung", "feuchtigkeit", "feuchte", "abmessung", "strom", "leistung", "temperatuur",
  "temperaturbereich", "aufbewahrung", "umgebungs", "anschluss", "zulassig", "zugelassen",
  "energieverbrauch", "eigenverbrauch", "nennspannung", "betriebs", "halterung", "gehause",
  "opslag", "werking", "afmeting", "vermogen", "spanningsbereik",
  "temperatuurbereik", "opbevaring", "arbejds", "spaending", "lagring", "kapasitet",
];

/** Whether this name reads as something other than English. */
export function looksForeign(name: string): boolean {
  if (ACCENTED.test(name) || ROMANCE.test(name)) return true;
  const words = wordsOf(name);
  if (words.some((word) => FOREIGN_TERMS.has(word))) return true;
  const flat = words.join(" ");
  return FOREIGN_STEMS.some((stem) => flat.includes(stem));
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
export function withoutRedundantTranslations<T extends { id: string; model: string; name: string; value: string; unit?: string; english?: string }>(
  specs: readonly T[],
): { keep: T[]; dropped: T[]; kept: T[] } {
  const hasEnglish = new Set<string>();
  for (const spec of specs) if (!looksForeign(spec.name)) hasEnglish.add(spec.model);
  const redundant = (spec: T) => looksForeign(spec.name) && !spec.english && hasEnglish.has(spec.model);

  // One figure said in two languages, in two documents. NOCO's GENIUSPRO50 states its battery
  // capacity in a Spanish manual and again in a French one; neither repeats an English row, so
  // neither looked redundant, and the same 2000 Ah appeared twice. Same model, same value, same
  // unit and the same English name is the same figure, whichever document it came from.
  const said = new Map<string, T[]>();
  for (const spec of specs) {
    if (!spec.english || redundant(spec)) continue;
    const key = `${spec.model}|${spec.english}|${spec.value}|${spec.unit ?? ""}`;
    said.set(key, [...(said.get(key) ?? []), spec]);
  }
  const twice = new Set<string>();
  for (const rows of said.values()) for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id)).slice(1)) twice.add(row.id);

  const gone = (spec: T) => redundant(spec) || twice.has(spec.id);
  const orphaned = (spec: T) => looksForeign(spec.name) && !spec.english && !hasEnglish.has(spec.model);
  return {
    keep: specs.filter((spec) => !gone(spec)),
    dropped: specs.filter(gone),
    kept: specs.filter(orphaned),
  };
}

/**
 * Words an English specification uses and its translations do not.
 *
 * A positive test, because the negative one cannot settle a tie. NOCO states one figure as "12 V
 * snel opladen", "12V-Schnellladefunktion", "Chargement rapide 12V" and "12V Fast Charge", and
 * none of the four reads as foreign on its own, so choosing between them alphabetically kept the
 * Dutch. This asks which of them is English rather than which is not.
 */
const ENGLISH_TERMS = new Set([
  "charge", "charging", "output", "input", "voltage", "current", "power", "temperature", "weight",
  "capacity", "time", "battery", "fast", "device", "protection", "cooling", "fuse", "dimensions",
  "lumens", "operating", "storage", "internal", "maximum", "minimum", "rated", "nominal", "peak",
  "size", "type", "range", "chemistry", "housing", "case", "duty", "cycle", "motor", "air", "flow",
  "pressure", "humidity", "altitude", "efficiency", "frequency", "phase", "cylinders", "port",
]);

/** How many English specification words a name uses. Higher wins a tie between languages. */
export function englishWords(name: string): number {
  return wordsOf(name).filter((word) => ENGLISH_TERMS.has(word)).length;
}

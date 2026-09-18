import { repairMojibake } from "./text.ts";

/**
 * The English name for a figure a maker printed in another language.
 *
 * A reviewed table rather than a model call. There are seventy-six of these, they come from a
 * handful of multilingual user guides, and a translation somebody can read and correct is worth
 * more than one produced the same way as the figure it labels. A name that is not here gets no
 * English name at all: absence is representable, a wrong label is not.
 *
 * The printed name always stays on the record. This is the aligned name beside it, so a consumer
 * can group "Capacité de batterie", "Capacidad de batería" and "Battery capacity" as one figure.
 */
export const ENGLISH: Record<string, string> = {
  // French
  "débit max.": "Maximum flow rate",
  "hauteur manométrique max.": "Maximum head",
  "Température de chargement": "Charging temperature",
  "Température de fonctionnement": "Operating temperature",
  "Température de stockage": "Storage temperature",
  "Évaluation de courant de crête": "Peak current rating",
  "Entrée USB": "USB input",
  "USB-C (entrée)": "USB-C input",
  "Détection de tension basse": "Low voltage detection",
  "Tension d’entrée AC": "AC input voltage",
  "Capacité de batterie": "Battery capacity",
  "Capacité de la batterie": "Battery capacity",
  Capacité: "Capacity",
  Ampérage: "Current rating",
  "Protection du boétier": "Enclosure protection",
  "Température ambiante": "Ambient temperature",
  Température: "Temperature",
  "Débit de service": "Service flow rate",
  "Gammes de températures": "Temperature range",
  "Plage de température": "Temperature range",
  "Débit d’eau minimum": "Minimum water flow",
  "Dispositifs de sécurité": "Safety devices",
  "Système d’évacuation": "Drain system",
  "Consommation électrique(avec système de protection contre le gel activé)":
    "Power consumption, freeze protection active",
  "Consommation électrique(en mode de fonctionnement normal)":
    "Power consumption, normal operation",
  "Température prédéfinie – Comf": "Preset temperature, Comfort",
  "Température prédéfinie – High": "Preset temperature, High",
  "Température prédéfinie – Low": "Preset temperature, Low",
  "CAPACITÉ NOMINALE": "Rated capacity",
  "Capacité nominale": "Rated capacity",
  "Chute de pression au débit de service nominal": "Pressure drop at rated service flow",
  "Écoulement de service nominal": "Rated service flow",
  "Débit maximum pendant la régénération": "Maximum flow during regeneration",
  "Dimensions du réservoir": "Tank dimensions",
  "Efficacité nominale": "Rated efficiency",
  "Pression de fonctionnement": "Operating pressure",
  "Résine échangeuse d'ions": "Ion exchange resin",
  "Type de sel acceptable": "Acceptable salt type",
  "Puissance de sortie": "Output power",
  "Courant de sortie CC maximum": "Maximum DC output current",

  "POIDS (DÉBALLÉ)": "Weight, unpacked",
  "CONSOMMATION D’ÉLECTRICITÉ": "Power consumption",
  "PLAGE DE TEMPÉRATURE DE CONGÉLATEUR": "Freezer temperature range",
  "PLAGE DE TEMPÉRATURE DE RÉFRIGÉRATEUR": "Refrigerator temperature range",
  "HAUTEUR DE FLAMME MINIMUM": "Minimum flame height",
  "TAUX D’ENTRÉE DU BRÛleUR": "Burner input rate",
  "Profondeur maximale des armoires au-dessus de la surface de cuisson":
    "Maximum depth of cabinets above the cooking surface",
  "Consommation d’électricité": "Power consumption",
  "Délai d'activation du relais": "Relay activation delay",
  "Résistance de la bobine du relais": "Relay coil resistance",
  "Tension de sortie": "Output voltage",
  "Tension minimale du générateur": "Minimum generator voltage",

  // Spanish
  "Diámetro del orificio del cable": "Cable entry diameter",
  "Tipo de batería": "Battery type",
  "Tipo de baterías": "Battery type",
  "Tipo de batería compatible": "Compatible battery type",
  "Voltaje de la batería": "Battery voltage",
  "Voltaje mínimo para arranque": "Minimum starting voltage",
  "Batería interna": "Internal battery",
  "Corriente máxima": "Maximum current",
  "Potencia de carga rápida de 12 V": "12 V fast charge power",
  "Protección de la cubierta": "Enclosure protection",
  "Carga rápida de 12 V": "12 V fast charge",
  "Carga rápida": "Fast charge",
  "Composición química de la batería": "Battery chemistry",
  "Química de la batería": "Battery chemistry",
  "Rango de voltaje de la batería": "Battery voltage range",
  "Tiempo de carga rápida de 12 V": "12 V fast charge time",
  "Tensión de la batería compatible": "Compatible battery voltage",
  "Capacidad de batería": "Battery capacity",
  "Capacidad de la batería": "Battery capacity",
  "Detección de bajo voltaje": "Low voltage detection",
  "Temperatura máxima": "Maximum temperature",
  Microplásticos: "Microplastics",
  "Partículas clase I": "Class I particulates",
  "Reducción de cloro": "Chlorine reduction",
  "Reducción de microplásticos": "Microplastic reduction",
  "Reducción de partículas clase I": "Class I particulate reduction",
  "Reducción de plomo 6.5": "Lead reduction at pH 6.5",
  "Reducción de plomo 8.5": "Lead reduction at pH 8.5",
  "Reducción de quistes": "Cyst reduction",

  // Pentair's solar drives, whose Spanish sheet is the only one we reached.
  "Tensíón del Generador": "Generator voltage",
  "Corriente fotovoltaica solar máxima en la serie": "Maximum solar PV current in series",
  "Corriente máxima de salida": "Maximum output current",
  "Máxima potencia sostenida": "Maximum sustained power",
  "Tensión máxima del circuito abierto solar": "Maximum solar open-circuit voltage",
  "Máximo voltaje del circuito abierto solar": "Maximum solar open-circuit voltage",

  // Portuguese
  "Potência da recarga rápida de 12 V": "12 V fast charge power",
  "Potência de recarga rápida de 12 V": "12 V fast charge power",
  "Tempo de recarga rápida de 12 V": "12 V fast charge time",
  "Proteção da caixa": "Enclosure protection",
  "Proteção do revestimento": "Enclosure protection",
  "Classificação do carregador": "Charger rating",
  "Química da bateria": "Battery chemistry",
  "Químicas das baterias": "Battery chemistry",
  "Potência de Saída": "Output power",
  Potencia: "Power",
  "Potencia nominal": "Rated power",
  Puissance: "Power",
  "USB-C (saída)": "USB-C output",
  "USB (saída)": "USB output",

  // Italian
  "Corrente massima in modalità di Manual Override": "Maximum current in manual override mode",
  "Intensità di corrente della porta d'ingresso USB": "USB input port current",

  // Turkish
  "Başlangıç Akımı": "Starting current",

  // German
  Nennleistung: "Rated power",
};

/** The English name for a printed one, or undefined when nobody has given it one. */
export function englishName(printed: string): string | undefined {
  const name = repairMojibake(printed).trim();
  return ENGLISH[name] ?? ENGLISH[printed];
}

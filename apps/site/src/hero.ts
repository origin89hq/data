/**
 * The figure the hero card leads with, by the kind of equipment: a generator's running power, a
 * battery's capacity. One unit for every model once showed a generator by its starter battery. The
 * order is the order of preference when several kinds have an example.
 */
export const HEADLINES = [
  { kind: "generator", key: "generator.power.running", label: "Running power" },
  { kind: "battery", key: "battery.capacity", label: "Capacity" },
  { kind: "inverter", key: "inverter.power.continuous", label: "Continuous power" },
  { kind: "inverter-charger", key: "inverter.power.continuous", label: "Continuous power" },
  { kind: "charge-controller", key: "charge.current.max", label: "Charge current" },
  { kind: "ac-charger", key: "charge.current.max", label: "Charge current" },
  { kind: "dc-dc-converter", key: "charge.current.max", label: "Charge current" },
  { kind: "panel", key: "panel.power.stc", label: "Power at STC" },
  { kind: "pump", key: "pump.flow.rated", label: "Rated flow" },
] as const;

/**
 * One figure for the first kind above that has one: read off a page, and not doubted, since the
 * card's point is that the source holds. Where a model states it for several fuels, the largest.
 */
export const HERO_QUERY = `WITH headline(rank, kind, key) AS (
  VALUES ${HEADLINES.map(({ kind, key }, rank) => `(${rank}, '${kind}', '${key}')`).join(", ")}
)
SELECT m.id AS model_id, m.kind, p.value, p.unit, p.fuel, p.page, p.basis, f.name AS maker, f.logo
FROM properties p
JOIN models m ON m.id = p.model_id
JOIN headline h ON h.kind = m.kind AND h.key = p.key
JOIN specs s ON s.id = p.claim_id
LEFT JOIN manufacturers f ON f.id = m.manufacturer_id
WHERE p.status = 'value' AND p.value IS NOT NULL AND p.page IS NOT NULL AND s.doubt IS NULL
ORDER BY h.rank, m.id, p.value DESC
LIMIT 1`;

/** What the card shows. */
export interface HeroFigure {
  model: string;
  kind: string;
  label: string;
  /** The fuel a generator's figure holds for, where the source names one. */
  condition: string | undefined;
  value: string;
  unit: string;
  page: number;
  basis: string;
  maker: string | undefined;
  logo: string | undefined;
}

const FUELS: Record<string, string> = {
  gasoline: "gasoline",
  lpg: "LPG",
  "natural-gas": "natural gas",
};

/** How a figure arrived, never promoted: nothing here says a person checked it. */
const BASES: Record<string, string> = { extracted: "Extracted", feed: "Public feed" };

const figure = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** The card's figure from a row of `HERO_QUERY`, or nothing when the row is not one it can show. */
export function heroFigure(row: Record<string, unknown> | undefined): HeroFigure | undefined {
  const headline = HEADLINES.find(({ kind }) => kind === row?.kind);
  if (!row || !headline) return undefined;
  const { model_id, value, unit, fuel, page, basis, maker, logo } = row;
  if (
    typeof model_id !== "string" ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    typeof unit !== "string" ||
    typeof page !== "number" ||
    typeof basis !== "string"
  ) {
    return undefined;
  }
  return {
    model: model_id,
    kind: headline.kind,
    label: headline.label,
    condition: typeof fuel === "string" ? (FUELS[fuel] ?? fuel) : undefined,
    value: figure.format(value),
    unit,
    page,
    basis: BASES[basis] ?? basis,
    maker: typeof maker === "string" ? maker : undefined,
    logo: typeof logo === "string" ? logo : undefined,
  };
}

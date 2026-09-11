import type { Dialect } from "@origin89/equipment-schema/dialect";
import { type DialectLink, LINK_CITATIONS } from "@origin89/equipment-schema/model";

/**
 * The link a catalogue entry gives a model it names: the catalogue's own claim, marked as a
 * name match rather than a register match, citing nothing of its own and `unverified`, since
 * a link's confidence is what its sources support and this one has none. The dialect's sources
 * and confidence support the dialect, not this one model, and stay on it (#84).
 */
export function catalogueLink(dialect: Pick<Dialect, "id">): DialectLink {
  return {
    dialect: dialect.id,
    evidence: { kind: "catalogue-name", sources: [] },
    confidence: "unverified",
  };
}

/** How much a link's evidence says, most first: a register match beats the maker's word, which beats the catalogue naming the model. */
const STRENGTH: Record<DialectLink["evidence"]["kind"], number> = {
  "register-match": 2,
  "vendor-doc": 1,
  "catalogue-name": 0,
};

/** How much a confidence says, most first, for keeping the stronger of two. */
const RANK: Record<DialectLink["confidence"], number> = {
  "vendor-doc": 3,
  "community-crosschecked": 2,
  "community-single": 1,
  unverified: 0,
};

/**
 * Two links of one kind on one dialect, as one: every distinct citation of both, the stronger
 * confidence, and a firmware range with each bound from whichever named it. Two duplicate
 * records a person wrote separately lose no provenance when they are folded into one; more
 * citations between them than a link may carry is refused, for a person to settle, never cut.
 */
function combined(held: DialectLink, other: DialectLink): DialectLink {
  const seen = new Set<string>();
  const sources = [...held.evidence.sources, ...other.evidence.sources].filter((c) => {
    const key = `${c.source}\u0000${c.citation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (sources.length > LINK_CITATIONS)
    throw new RangeError(
      `the links to ${held.dialect} cite ${sources.length} sources between them, more than the ${LINK_CITATIONS} a link may carry`,
    );
  const min = held.firmware?.min ?? other.firmware?.min;
  const max = held.firmware?.max ?? other.firmware?.max;
  return {
    dialect: held.dialect,
    evidence:
      held.evidence.kind === "catalogue-name"
        ? { kind: "catalogue-name", sources: [] }
        : { kind: held.evidence.kind, sources },
    confidence: RANK[other.confidence] > RANK[held.confidence] ? other.confidence : held.confidence,
    ...(min !== undefined || max !== undefined
      ? {
          firmware: {
            ...(min !== undefined ? { min } : {}),
            ...(max !== undefined ? { max } : {}),
          },
        }
      : {}),
  };
}

/**
 * Links by dialect, sorted by dialect id. Where two lists link one dialect the stronger evidence
 * wins whichever list it came from; between two of one kind the two are combined, so a merge
 * of duplicate records keeps every citation, the stronger confidence and every firmware bound
 * a person recorded on either. Two catalogue claims are one claim.
 */
export function mergeLinks(...lists: readonly (readonly DialectLink[])[]): DialectLink[] {
  const byDialect = new Map<string, DialectLink>();
  for (const list of lists)
    for (const link of list) {
      const held = byDialect.get(link.dialect);
      if (!held || STRENGTH[link.evidence.kind] > STRENGTH[held.evidence.kind])
        byDialect.set(link.dialect, link);
      else if (STRENGTH[link.evidence.kind] === STRENGTH[held.evidence.kind])
        byDialect.set(link.dialect, combined(held, link));
    }
  return [...byDialect.values()].sort((a, b) => a.dialect.localeCompare(b.dialect));
}

/** Whether two link lists say the same thing: the same dialects, each with the same evidence, confidence and firmware. */
export function sameLinks(a: readonly DialectLink[], b: readonly DialectLink[]): boolean {
  const text = (list: readonly DialectLink[]) =>
    JSON.stringify([...list].sort((x, y) => x.dialect.localeCompare(y.dialect)));
  return text(a) === text(b);
}

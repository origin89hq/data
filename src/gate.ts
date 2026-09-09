import type { Brand, BrandEvidence } from "../schema/brand.ts";
import type { Guess } from "../schema/guess.ts";
import type { Sighting } from "../schema/sighting.ts";

/** A brand string turned into a record id: lower case, one hyphen per run of anything else. */
export function brandId(brand: string): string {
  const slug = brand
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed";
}

/** How many examples and models a queue entry carries. Enough to recognise the brand, few enough to read. */
export const EVIDENCE_LIMIT = 6;

export interface GateInput {
  sightings: Sighting[];
  guesses: Map<string, Guess>;
  seenAt: string;
}

/**
 * Gather what the crawls say about each brand string. Sorted by in-scope listings, because the
 * brand behind forty charge controllers is worth a reviewer's minute and the one behind a single
 * cast-iron skillet is not.
 */
export function gatherBrands({ sightings, guesses, seenAt }: GateInput): { id: string; brand: string; evidence: BrandEvidence }[] {
  const rows = new Map<string, { brand: string; sellers: Set<string>; listings: number; inScope: number; kinds: Map<string, number>; models: Set<string>; proposed: Set<string>; examples: string[] }>();
  for (const s of sightings) {
    const brand = s.brand?.trim();
    if (!brand) continue;
    const id = brandId(brand);
    const row = rows.get(id) ?? { brand, sellers: new Set(), listings: 0, inScope: 0, kinds: new Map(), models: new Set(), proposed: new Set(), examples: [] };
    row.sellers.add(s.seller);
    row.listings += 1;
    if (row.examples.length < EVIDENCE_LIMIT) row.examples.push(s.title);
    if (s.model) row.models.add(s.model);
    const g = guesses.get(`${s.seller}/${s.productId}`);
    if (g) {
      row.kinds.set(g.kind, (row.kinds.get(g.kind) ?? 0) + 1);
      if (g.kind !== "out-of-scope") row.inScope += 1;
      if (g.model) row.models.add(g.model);
      if (g.manufacturer) row.proposed.add(g.manufacturer);
    }
    rows.set(id, row);
  }
  return [...rows.entries()]
    .map(([id, r]) => ({
      id,
      brand: r.brand,
      evidence: {
        sellers: [...r.sellers].sort(),
        listings: r.listings,
        inScope: r.inScope,
        kinds: [...r.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`),
        models: [...r.models].slice(0, EVIDENCE_LIMIT),
        proposed: [...r.proposed].slice(0, EVIDENCE_LIMIT),
        examples: r.examples,
        seenAt,
      } satisfies BrandEvidence,
    }))
    .sort((a, b) => b.evidence.inScope - a.evidence.inScope || b.evidence.listings - a.evidence.listings || a.id.localeCompare(b.id));
}

/**
 * Fold fresh evidence into the queue. A brand a person already decided keeps its decision and
 * gets new evidence; a new one arrives unresolved. Nothing here ever writes a decision — that is
 * the gate, and a model's proposal is carried as evidence, never as the answer.
 */
export function mergeBrand(existing: Brand | undefined, found: { id: string; brand: string; evidence: BrandEvidence }): Brand {
  if (!existing) return { id: found.id, brand: found.brand, decision: "unresolved", evidence: found.evidence };
  const merged: Brand = { ...existing, evidence: mergeEvidence(existing.evidence, found.evidence) };
  return merged;
}

function mergeEvidence(old: BrandEvidence, fresh: BrandEvidence): BrandEvidence {
  const union = (a: string[], b: string[], limit = EVIDENCE_LIMIT) => [...new Set([...a, ...b])].slice(0, limit);
  return {
    sellers: [...new Set([...old.sellers, ...fresh.sellers])].sort(),
    listings: fresh.listings,
    inScope: fresh.inScope,
    kinds: fresh.kinds,
    models: union(fresh.models, old.models),
    proposed: union(fresh.proposed, old.proposed),
    examples: union(fresh.examples, old.examples),
    seenAt: fresh.seenAt > old.seenAt ? fresh.seenAt : old.seenAt,
  };
}

/** Resolve a sighting's brand string through the decided brands. Returns nothing while the gate has not answered. */
export function resolveBrand(brands: Brand[], brand: string | undefined): string | undefined {
  if (!brand) return undefined;
  const id = brandId(brand);
  const record = brands.find((b) => b.id === id);
  return record?.decision === "manufacturer" ? record.manufacturer : undefined;
}

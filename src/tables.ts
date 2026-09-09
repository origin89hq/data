import type { Records } from "./records.ts";

export type Row = Record<string, string | boolean | number | undefined>;

/** A flat table and the column types the Parquet writer needs, since CSV carries none. */
export interface Table {
  name: string;
  columns: { name: string; type: "VARCHAR" | "BOOLEAN" | "INTEGER" }[];
  rows: Row[];
}

/** Flatten the nested records into narrow tables joined by id. Every list becomes a table with a position column, so order survives. */
export function tables(records: Records): Table[] {
  const V = "VARCHAR" as const;
  const dialects = records.dialects.map((d) => ({
    id: d.id,
    family: d.family,
    driver_status: d.driver.status,
    driver_id: d.driver.id,
    driver_note: d.driver.note,
    confidence: d.confidence,
    refuter: d.refuter,
    confidence_note: d.confidenceNote,
    cross_reference: d.crossReference,
    transport: d.transport,
    blocks: d.blocks,
    shared_map_evidence: d.sharedMapEvidence,
    refuted_on_review: d.refutedOnReview,
    shared_map_claim_dropped: d.sharedMapClaimDropped ?? false,
    downgraded_on_review: d.downgradedOnReview,
    unmapped_reports: d.unmappedReports,
    refiled_from: d.refiledFrom,
    possible_duplicate: d.possibleDuplicate ?? false,
  }));
  const col = (name: string, type: "VARCHAR" | "BOOLEAN" | "INTEGER" = V) => ({ name, type });
  return [
    {
      name: "dialects",
      columns: [
        col("id"), col("family"), col("driver_status"), col("driver_id"), col("driver_note"), col("confidence"), col("refuter"),
        col("confidence_note"), col("cross_reference"), col("transport"), col("blocks"), col("shared_map_evidence"),
        col("refuted_on_review"), col("shared_map_claim_dropped", "BOOLEAN"), col("downgraded_on_review"), col("unmapped_reports"),
        col("refiled_from"), col("possible_duplicate", "BOOLEAN"),
      ],
      rows: dialects,
    },
    {
      name: "dialect_sources",
      columns: [col("dialect_id"), col("position", "INTEGER"), col("source_id"), col("citation")],
      rows: records.dialects.flatMap((d) => d.sources.map((c, i) => ({ dialect_id: d.id, position: i, source_id: c.source, citation: c.citation }))),
    },
    {
      name: "dialect_models",
      columns: [col("dialect_id"), col("position", "INTEGER"), col("name"), col("tier"), col("rating"), col("sold_by"), col("notes")],
      rows: records.dialects.flatMap((d) =>
        (d.models ?? []).map((m, i) => ({ dialect_id: d.id, position: i, name: m.name, tier: m.tier, rating: m.rating, sold_by: m.soldBy, notes: m.notes })),
      ),
    },
    {
      name: "dialect_kinds",
      columns: [col("dialect_id"), col("direction"), col("position", "INTEGER"), col("kind")],
      rows: records.dialects.flatMap((d) => [
        ...(d.reports ?? []).map((k, i) => ({ dialect_id: d.id, direction: "reports", position: i, kind: k })),
        ...(d.accepts ?? []).map((k, i) => ({ dialect_id: d.id, direction: "accepts", position: i, kind: k })),
      ]),
    },
    {
      name: "dialect_gotchas",
      columns: [col("dialect_id"), col("position", "INTEGER"), col("text")],
      rows: records.dialects.flatMap((d) => (d.gotchas ?? []).map((g, i) => ({ dialect_id: d.id, position: i, text: g }))),
    },
    {
      name: "dialect_see_also",
      columns: [col("dialect_id"), col("other_id")],
      rows: records.dialects.flatMap((d) => (d.seeAlso ?? []).map((o) => ({ dialect_id: d.id, other_id: o }))),
    },
    {
      name: "manufacturers",
      columns: [col("id"), col("name"), col("website"), col("country"), col("notes")],
      rows: records.manufacturers.map((m) => ({ id: m.id, name: m.name, website: m.website, country: m.country, notes: m.notes })),
    },
    {
      name: "manufacturer_domains",
      columns: [col("manufacturer_id"), col("domain")],
      rows: records.manufacturers.flatMap((m) => m.domains.map((domain) => ({ manufacturer_id: m.id, domain }))),
    },
    {
      name: "brands",
      columns: [col("id"), col("brand"), col("decision"), col("manufacturer_id"), col("reason"), col("listings", "INTEGER"), col("in_scope", "INTEGER"), col("seen_at"), col("checked_at"), col("reviewed_by")],
      rows: records.brands.map((b) => ({
        id: b.id, brand: b.brand, decision: b.decision, manufacturer_id: b.manufacturer, reason: b.reason,
        listings: b.evidence.listings, in_scope: b.evidence.inScope, seen_at: b.evidence.seenAt, checked_at: b.checkedAt, reviewed_by: b.reviewedBy,
      })),
    },
    {
      name: "brand_sellers",
      columns: [col("brand_id"), col("seller")],
      rows: records.brands.flatMap((b) => b.evidence.sellers.map((seller) => ({ brand_id: b.id, seller }))),
    },
    {
      name: "sources",
      columns: [col("id"), col("url"), col("path"), col("title"), col("publisher"), col("revision"), col("sha256"), col("retrieved_at"), col("redistributable", "BOOLEAN")],
      rows: records.sources.map((s) => ({
        id: s.id, url: s.url, path: s.path, title: s.title, publisher: s.publisher, revision: s.revision, sha256: s.sha256, retrieved_at: s.retrievedAt, redistributable: s.redistributable,
      })),
    },
  ];
}

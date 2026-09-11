import { logoKey } from "./logos.ts";

/** Where a published logo is served from. The Worker is the only thing that reads the archive. */
const LOGO_BASE = "https://data.origin89.com";

import { modelKey, nameKey } from "@origin89/equipment-api/keys";
import { attachMakers, type FeedModel, feedSource, feedSpecId, readFeeds } from "./feeds.ts";
import { buildProperties } from "./properties.ts";
import type { Records } from "./records.ts";
import { canonicalUnit, concerns as figureConcerns } from "./units.ts";
import type { DialectKindDirection, ModelKeyVia } from "./vocabulary.ts";

export type Row = Record<string, string | boolean | number | undefined>;

/** A flat table and the column types the Parquet writer needs, since CSV carries none. */
export interface Table {
  name: string;
  columns: { name: string; type: "VARCHAR" | "BOOLEAN" | "INTEGER" | "DOUBLE" }[];
  rows: Row[];
}

/** Flatten the nested records into narrow tables joined by id. Every list becomes a table with a position column, so order survives. */
export function tables(records: Records, feeds = readFeeds()): Table[] {
  // Two tiers in one table, told apart by a column: a `record` in this repository, or a `feed`
  // row a public dataset states. The tier says where a row comes from and nothing about who
  // checked it. It said `reviewed` for every record while a model had read all of them and no
  // person had confirmed one (#45); `reviewed_by` is the only column that says a person did.
  const brandsByMaker = new Map<string, string[]>();
  for (const b of records.brands)
    if (b.decision === "manufacturer" && b.manufacturer)
      brandsByMaker.set(b.manufacturer, [...(brandsByMaker.get(b.manufacturer) ?? []), b.brand]);
  const feedRows = feeds.flatMap(({ feed, models }) =>
    attachMakers(
      models,
      records.manufacturers.map((m) => ({
        id: m.id,
        name: m.name,
        aliases: brandsByMaker.get(m.id) ?? [],
      })),
    ).map((m) => ({ feed, model: m })),
  );
  // The normalized properties beside the printed figures, and what could not be normalized (#82).
  const normalized = buildProperties({
    models: records.models,
    specs: records.specs,
    mappings: records.mappings,
    feeds: feedRows,
  });

  const V = "VARCHAR" as const;
  const dialects = records.dialects.map((d) => ({
    id: d.id,
    family: d.family,
    manufacturer: d.manufacturer,
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
  const col = (name: string, type: Table["columns"][number]["type"] = V) => ({ name, type });
  return [
    {
      name: "dialects",
      columns: [
        col("id"),
        col("manufacturer"),
        col("family"),
        col("driver_status"),
        col("driver_id"),
        col("driver_note"),
        col("confidence"),
        col("refuter"),
        col("confidence_note"),
        col("cross_reference"),
        col("transport"),
        col("blocks"),
        col("shared_map_evidence"),
        col("refuted_on_review"),
        col("shared_map_claim_dropped", "BOOLEAN"),
        col("downgraded_on_review"),
        col("unmapped_reports"),
        col("refiled_from"),
        col("possible_duplicate", "BOOLEAN"),
      ],
      rows: dialects,
    },
    {
      name: "dialect_sources",
      columns: [col("dialect_id"), col("position", "INTEGER"), col("source_id"), col("citation")],
      rows: records.dialects.flatMap((d) =>
        d.sources.map((c, i) => ({
          dialect_id: d.id,
          position: i,
          source_id: c.source,
          citation: c.citation,
        })),
      ),
    },
    {
      name: "dialect_models",
      columns: [
        col("dialect_id"),
        col("position", "INTEGER"),
        col("name"),
        col("tier"),
        col("rating"),
        col("sold_by"),
        col("notes"),
      ],
      rows: records.dialects.flatMap((d) =>
        (d.models ?? []).map((m, i) => ({
          dialect_id: d.id,
          position: i,
          name: m.name,
          tier: m.tier,
          rating: m.rating,
          sold_by: m.soldBy,
          notes: m.notes,
        })),
      ),
    },
    {
      name: "dialect_kinds",
      columns: [col("dialect_id"), col("direction"), col("position", "INTEGER"), col("kind")],
      rows: records.dialects.flatMap((d) => [
        ...(d.reports ?? []).map((k, i) => ({
          dialect_id: d.id,
          direction: "reports" satisfies DialectKindDirection,
          position: i,
          kind: k,
        })),
        ...(d.accepts ?? []).map((k, i) => ({
          dialect_id: d.id,
          direction: "accepts" satisfies DialectKindDirection,
          position: i,
          kind: k,
        })),
      ]),
    },
    {
      name: "dialect_gotchas",
      columns: [col("dialect_id"), col("position", "INTEGER"), col("text")],
      rows: records.dialects.flatMap((d) =>
        (d.gotchas ?? []).map((g, i) => ({ dialect_id: d.id, position: i, text: g })),
      ),
    },
    {
      name: "dialect_see_also",
      columns: [col("dialect_id"), col("other_id")],
      rows: records.dialects.flatMap((d) =>
        (d.seeAlso ?? []).map((o) => ({ dialect_id: d.id, other_id: o })),
      ),
    },
    {
      name: "manufacturers",
      // `logo` is the address of a copy, not the image. A mark is a trademark rather than a work
      // this licence can give away, so `logo_from` says who published it and `logo_source` where it
      // was fetched, and anybody who needs different terms can go to the maker.
      columns: [
        col("id"),
        col("name"),
        col("website"),
        col("country"),
        col("notes"),
        col("logo"),
        col("logo_widths"),
        col("logo_from"),
        col("logo_source"),
      ],
      rows: records.manufacturers.map((m) => ({
        id: m.id,
        name: m.name,
        website: m.website,
        country: m.country,
        notes: m.notes,
        logo: m.logo
          ? `${LOGO_BASE}/${logoKey(m.id, m.logo.widths[m.logo.widths.length - 1])}`
          : undefined,
        logo_widths: m.logo?.widths.join(" "),
        logo_from: m.logo?.from,
        logo_source: m.logo?.source,
      })),
    },
    {
      name: "manufacturer_domains",
      columns: [col("manufacturer_id"), col("domain")],
      rows: records.manufacturers.flatMap((m) =>
        m.domains.map((domain) => ({ manufacturer_id: m.id, domain })),
      ),
    },
    {
      name: "brands",
      columns: [
        col("id"),
        col("brand"),
        col("decision"),
        col("manufacturer_id"),
        col("reason"),
        col("listings", "INTEGER"),
        col("in_scope", "INTEGER"),
        col("seen_at"),
        col("checked_at"),
        col("reviewed_by"),
      ],
      rows: records.brands.map((b) => ({
        id: b.id,
        brand: b.brand,
        decision: b.decision,
        manufacturer_id: b.manufacturer,
        reason: b.reason,
        listings: b.evidence.listings,
        in_scope: b.evidence.inScope,
        seen_at: b.evidence.seenAt,
        checked_at: b.checkedAt,
        reviewed_by: b.reviewedBy,
      })),
    },
    {
      name: "brand_sellers",
      columns: [col("brand_id"), col("seller")],
      rows: records.brands.flatMap((b) =>
        b.evidence.sellers.map((seller) => ({ brand_id: b.id, seller })),
      ),
    },
    {
      name: "models",
      columns: [
        col("id"),
        col("tier"),
        col("source_feed"),
        col("manufacturer_id"),
        col("manufacturer_name"),
        col("name"),
        col("kind"),
        col("variant"),
        col("family"),
        col("checked_at"),
        col("reviewed_by"),
        col("basis"),
      ],
      rows: [
        ...records.models.map((m) => ({
          id: m.id,
          tier: "record",
          source_feed: undefined,
          manufacturer_id: m.manufacturer,
          manufacturer_name: undefined,
          name: m.name,
          kind: m.kind,
          variant: m.variant,
          family: m.family,
          checked_at: m.checkedAt,
          reviewed_by: m.reviewedBy,
          basis: m.basis,
        })),
        ...feedRows.map(({ feed, model }) => ({
          id: model.id,
          tier: "feed",
          source_feed: feed.id,
          manufacturer_id: model.manufacturer,
          manufacturer_name: model.manufacturerName,
          name: model.name,
          kind: model.kind,
          variant: undefined,
          family: undefined,
          checked_at: feed.retrievedAt,
          reviewed_by: undefined,
          basis: undefined,
        })),
      ],
    },
    {
      name: "model_aliases",
      columns: [col("model_id"), col("alias")],
      rows: records.models.flatMap((m) => m.aliases.map((alias) => ({ model_id: m.id, alias }))),
    },
    {
      // Every name a model answers to, under every name its maker goes by, keyed by the one rule
      // in `@origin89/equipment-api/keys` (#83). A key two rows share is ambiguous, and stays so.
      name: "model_keys",
      columns: [col("model_id"), col("key"), col("name_key"), col("label"), col("via")],
      rows: modelKeyRows(records, brandsByMaker, feedRows),
    },
    {
      name: "model_dialects",
      columns: [col("model_id"), col("dialect_id")],
      rows: records.models.flatMap((m) =>
        m.dialects.map((dialect_id) => ({ model_id: m.id, dialect_id })),
      ),
    },
    {
      name: "specs",
      columns: [
        col("id"),
        col("tier"),
        col("model_id"),
        col("name"),
        col("english"),
        col("value"),
        col("unit"),
        col("conditions"),
        col("source_id"),
        col("page", "INTEGER"),
        col("confidence"),
        col("extracted_by"),
        col("reviewed_by"),
        col("doubt"),
      ],
      rows: [
        // `doubt` says why a figure would not be trusted for sizing anything, so a reader does
        // not have to work it out and a clean figure is visibly clean.
        // `english` carries the aligned name when a maker printed the figure in another language, so a
        // reader can group a French sheet's "Capacité de batterie" with an English one's.
        ...records.specs.map((s) => ({
          id: s.id,
          tier: "record",
          model_id: s.model,
          name: s.name,
          english: s.english,
          value: s.value,
          unit: s.unit,
          conditions: s.conditions,
          source_id: s.source,
          page: s.page,
          confidence: s.confidence,
          extracted_by: s.extractedBy,
          reviewed_by: s.reviewedBy,
          doubt: figureConcerns(s).join("; ") || undefined,
        })),
        // A feed figure's id is its model and its name, never its position: a position moved
        // whenever a column was added or a cell was blank, and a consumer keyed to the id then
        // saw a figure deleted and another added when nothing about the fact had changed. The
        // name is never cut: a model id near its own cap once lost the tail of "Temperature
        // coefficient of …" to a length limit here, and three figures became one id. The
        // properties cite the same id, so it is made in one place.
        ...feedRows.flatMap(({ model }) =>
          model.specs.map((spec) => ({
            id: feedSpecId(model.id, spec.name),
            tier: "feed",
            model_id: model.id,
            name: spec.name,
            english: undefined,
            value: spec.value,
            unit: canonicalUnit(spec.unit) ?? spec.unit,
            conditions: spec.conditions,
            source_id: model.source,
            page: undefined,
            // A public dataset's own figure, stated with its unit. Nobody here read it out of a
            // document, so nothing extracted it and nobody has confirmed it either.
            confidence: "vendor-doc",
            extracted_by: undefined,
            reviewed_by: undefined,
            doubt:
              figureConcerns({
                name: spec.name,
                value: spec.value,
                unit: canonicalUnit(spec.unit),
              }).join("; ") || undefined,
          })),
        ),
      ],
    },
    {
      name: "properties",
      // One figure read under a registry key, as a number in the key's unit, with its conditions
      // as columns. `status` is `conflict` where two usable figures under the same conditions
      // disagree; both are published and the key is also a gap. `basis` is the claim's, never the
      // rule's: a mapping rule reads a figure, it does not review it.
      columns: [
        col("model_id"),
        col("key"),
        col("status"),
        col("value", "DOUBLE"),
        col("min", "DOUBLE"),
        col("max", "DOUBLE"),
        col("values"),
        col("unit"),
        col("stc", "BOOLEAN"),
        col("cell_temperature_c", "DOUBLE"),
        col("ambient_temperature_c", "DOUBLE"),
        col("bank_voltage_v", "DOUBLE"),
        col("discharge_hours", "DOUBLE"),
        col("duration_s", "DOUBLE"),
        col("mode"),
        col("note"),
        col("scope"),
        col("claim_id"),
        col("source_id"),
        col("page", "INTEGER"),
        col("mapped_by"),
        col("basis"),
      ],
      rows: normalized.properties.map((p) => ({
        model_id: p.model,
        key: p.key,
        status: p.status,
        value: p.value,
        min: p.min,
        max: p.max,
        values: p.values?.join(" "),
        unit: p.unit,
        stc: p.conditions.stc,
        cell_temperature_c: p.conditions.cellTemperature,
        ambient_temperature_c: p.conditions.ambientTemperature,
        bank_voltage_v: p.conditions.bankVoltage,
        discharge_hours: p.conditions.dischargeHours,
        duration_s: p.conditions.duration,
        mode: p.conditions.mode,
        note: p.conditions.note,
        scope: p.scope,
        claim_id: p.claim,
        source_id: p.source,
        page: p.page,
        mapped_by: p.mappedBy,
        basis: p.basis,
      })),
    },
    {
      name: "property_gaps",
      // A key a model's claims could not fill, and why. `claims` is how many printed figures the
      // rules read for it, so `no-claim` with none is a figure nobody has, and `unparsed` with
      // three is a figure the parser cannot yet read.
      columns: [
        col("model_id"),
        col("key"),
        col("reason"),
        col("detail"),
        col("claims", "INTEGER"),
      ],
      rows: normalized.gaps.map((g) => ({
        model_id: g.model,
        key: g.key,
        reason: g.reason,
        detail: g.detail,
        claims: g.claims,
      })),
    },
    {
      name: "property_coverage",
      // Per key and kind: how many models the key applies to, how many have a usable value, how
      // many of those also had a figure that could not be read (`partial`), and how many are gaps
      // of each reason. The build computes it, so a release says how far the normalized figures
      // reach.
      columns: [
        col("key"),
        col("kind"),
        col("models", "INTEGER"),
        col("values", "INTEGER"),
        col("partial", "INTEGER"),
        col("conflicts", "INTEGER"),
        col("no_claim", "INTEGER"),
        col("unparsed", "INTEGER"),
        col("needs_conditions", "INTEGER"),
      ],
      rows: normalized.coverage.map((c) => ({
        key: c.key,
        kind: c.kind,
        models: c.models,
        values: c.values,
        partial: c.partial,
        conflicts: c.conflicts,
        no_claim: c.noClaim,
        unparsed: c.unparsed,
        needs_conditions: c.needsConditions,
      })),
    },
    {
      name: "feeds",
      columns: [
        col("id"),
        col("title"),
        col("publisher"),
        col("license"),
        col("retrieved_at"),
        col("models", "INTEGER"),
        col("figures", "INTEGER"),
      ],
      rows: feeds.map(({ feed, models }) => ({
        id: feed.id,
        title: feed.title,
        publisher: feed.publisher,
        license: feed.license,
        retrieved_at: feed.retrievedAt,
        models: models.length,
        figures: models.reduce((n, m) => n + m.specs.length, 0),
      })),
    },
    {
      name: "sources",
      columns: [
        col("id"),
        col("url"),
        col("path"),
        col("title"),
        col("publisher"),
        col("revision"),
        col("sha256"),
        col("retrieved_at"),
        col("redistributable", "BOOLEAN"),
      ],
      rows: [
        ...records.sources.map((s) => ({
          id: s.id,
          url: s.url,
          path: s.path,
          title: s.title,
          publisher: s.publisher,
          revision: s.revision,
          sha256: s.sha256,
          retrieved_at: s.retrievedAt,
          redistributable: s.redistributable,
        })),
        // Each feed file is a source too, so a feed figure's `source_id` resolves like any other.
        ...feeds.flatMap(({ feed }) =>
          feed.files.map((file) => {
            const s = feedSource(feed, file);
            return {
              id: s.id,
              url: s.url,
              path: undefined,
              title: s.title,
              publisher: s.publisher,
              revision: s.revision,
              sha256: s.sha256,
              retrieved_at: s.retrievedAt,
              redistributable: s.redistributable,
            };
          }),
        ),
      ],
    },
  ];
}

/**
 * The ids a table repeats. A published table keyed by id has to have one row per id, or a store
 * that loads it keeps one row and says nothing about the other: `models` carried 147 repeated
 * feed ids and `specs` 1,347 before anything checked (#81).
 */
export function duplicateIds(table: Table): string[] {
  if (!table.columns.some((c) => c.name === "id")) return [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const row of table.rows) {
    const id = String(row.id);
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated].sort();
}

/**
 * The key rows of every model, record and feed alike. A record model is keyed under its maker's
 * name and each brand the gate confirmed for that maker; a feed row under the name the feed
 * prints, and under the same names as a record once it is attached to a maker.
 */
export function modelKeyRows(
  records: Pick<Records, "models" | "manufacturers">,
  brandsByMaker: ReadonlyMap<string, string[]>,
  feedRows: readonly { model: FeedModel }[],
): Row[] {
  const makerName = new Map(records.manufacturers.map((m) => [m.id, m.name]));
  const labelsOf = (maker: string | undefined, printed?: string): string[] => {
    const labels = printed ? [printed] : [];
    if (maker) labels.push(makerName.get(maker) ?? maker, ...(brandsByMaker.get(maker) ?? []));
    return [...new Set(labels)];
  };
  const out: Row[] = [];
  const seen = new Set<string>();
  const add = (model_id: string, labels: string[], names: [string, ModelKeyVia][]) => {
    for (const label of labels)
      for (const [name, via] of names) {
        const key = modelKey(label, name);
        if (!key || seen.has(`${model_id}\u0000${key}`)) continue;
        seen.add(`${model_id}\u0000${key}`);
        out.push({ model_id, key, name_key: nameKey(label, name), label, via });
      }
  };
  for (const m of records.models)
    add(m.id, labelsOf(m.manufacturer), [
      [m.name, "name"],
      ...m.aliases.map((a): [string, "alias"] => [a, "alias"]),
    ]);
  for (const { model } of feedRows)
    add(model.id, labelsOf(model.manufacturer, model.manufacturerName), [[model.name, "name"]]);
  return out;
}

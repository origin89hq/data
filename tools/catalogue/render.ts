import type { Dialect } from "@origin89/equipment-schema/dialect";
import type { Family } from "@origin89/equipment-schema/family";
import { CLAIM_DROPPED, DUPLICATES_HEAD, REFILED_HEAD, SEE_ALSO_TAIL } from "./parse.ts";

/** Render a family file from its records. The inverse of `parseFamilyFile`, byte for byte. */
export function renderFamilyFile(family: Family, dialects: Map<string, Dialect>): string {
  const ordered = family.order.map((id) => {
    const d = dialects.get(id);
    if (!d) throw new Error(`${family.id}: order names ${id}, which has no record`);
    return d;
  });
  const out: string[] = [family.intro, "", countLine(ordered), ""];
  const byId = (a: Dialect, b: Dialect) => a.id.localeCompare(b.id);
  const refiled = ordered.filter((d) => d.refiledFrom).sort(byId);
  if (refiled.length) {
    out.push(REFILED_HEAD, "");
    for (const d of refiled) out.push(`- \`${d.id}\` — researched as \`${d.refiledFrom}\``);
    out.push("");
  }
  const duplicates = ordered.filter((d) => d.possibleDuplicate).sort(byId);
  if (duplicates.length) {
    out.push(DUPLICATES_HEAD, "");
    for (const d of duplicates) out.push(`- \`${d.id}\``);
    out.push("");
  }
  out.push("---", "");
  const sections = new Map((family.sections ?? []).map((s) => [s.before, s.markdown]));
  for (const d of ordered) {
    const section = sections.get(d.id);
    if (section) out.push(section, "");
    out.push(renderEntry(d), "", "---", "");
  }
  return out.join("\n");
}

function countLine(dialects: Dialect[]): string {
  const counts = new Map<string, number>();
  for (const d of dialects) counts.set(d.confidence, (counts.get(d.confidence) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => `${tag} ${n}`);
  return `**${dialects.length} dialects** — ${parts.join(" · ")}`;
}

export function renderEntry(d: Dialect): string {
  const paragraphs: string[] = [`## Dialect: \`${d.id}\``];
  if (d.seeAlso)
    paragraphs.push(
      `**See also** ${d.seeAlso.map((id) => `\`${id}\``).join(", ")} ${SEE_ALSO_TAIL}`,
    );

  const header: string[] = [
    `**Driver** ${renderDriver(d)}`,
    `**Confidence** ${renderConfidence(d)}`,
  ];
  for (const s of d.sources) header.push(`**Source** ${s.citation}`);
  if (d.crossReference) header.push(`**See also** ${d.crossReference}`);
  if (d.transport !== undefined) header.push(`**Transport** ${d.transport}`);
  if (d.blocks !== undefined) header.push(`**Blocks** ${d.blocks}`);
  paragraphs.push(header.join("\n"));

  const kinds: string[] = [];
  if (d.reports) kinds.push(`\`reports\` ${d.reports.join(", ")}`);
  if (d.accepts) kinds.push(`\`accepts\` ${d.accepts.join(", ")}`);
  if (kinds.length) paragraphs.push(kinds.join("\n"));

  if (d.models) paragraphs.push(renderTable(d.models));
  if (d.sharedMapEvidence !== undefined)
    paragraphs.push(`**Shared-map evidence** ${d.sharedMapEvidence}`);
  if (d.refutedOnReview !== undefined)
    paragraphs.push(`**REFUTED on review.** ${d.refutedOnReview}`);
  if (d.sharedMapClaimDropped) paragraphs.push(CLAIM_DROPPED);
  if (d.downgradedOnReview !== undefined)
    paragraphs.push(`**Downgraded on review.** ${d.downgradedOnReview}`);
  if (d.gotchas) paragraphs.push(d.gotchas.map((g) => `- ${g}`).join("\n"));
  if (d.unmappedReports !== undefined)
    paragraphs.push(`**Reports with no \`MetricKind\`:** ${d.unmappedReports}`);
  return paragraphs.join("\n\n");
}

function renderDriver(d: Dialect): string {
  switch (d.driver.status) {
    case "shipped":
      return `✅ \`${d.driver.id}\``;
    case "planned":
      return "🎯 planned";
    case "possible":
      return "💡 none";
    case "not-planned":
      return "⛔ not planned";
  }
}

function renderConfidence(d: Dialect): string {
  const tag = `\`${d.confidence}\``;
  switch (d.refuter) {
    case "checked":
      return `${tag} · refuter checked`;
    case "not-checked":
      return `${tag} · **not checked** — no refuter ran`;
    case "unrecorded":
      return d.confidenceNote ? `${tag} ${d.confidenceNote}` : tag;
  }
}

function renderTable(models: Dialect["models"] & object): string {
  const wide = models.some((m) => m.tier !== undefined || m.soldBy !== undefined);
  const medium = !wide && models.some((m) => m.rating !== undefined || m.notes !== undefined);
  const columns: (keyof (typeof models)[number])[] = wide
    ? ["name", "tier", "rating", "soldBy", "notes"]
    : medium
      ? ["name", "rating", "notes"]
      : ["name"];
  const titles = {
    name: "Model",
    tier: "Tier",
    rating: "Rating",
    soldBy: "Sold by",
    notes: "Notes",
  };
  const lines = [
    `| ${columns.map((c) => titles[c]).join(" | ")} |`,
    `|${"---|".repeat(columns.length)}`,
  ];
  for (const m of models) lines.push(`| ${columns.map((c) => m[c] ?? "").join(" | ")} |`);
  return lines.join("\n");
}

import type { Source } from "../../schema/source.ts";

/** Where a citation points. `none` is a source cited by title alone, which a reviewer has to locate. */
export type Locator = { kind: "url"; url: string } | { kind: "path"; path: string } | { kind: "none" };

const URL_RE = /https?:\/\/[^\s<>()\[\]"']+/;
/** A file in a repository tree: `docs/x.pdf`, `crates/.../x.rs`, or either behind the absolute prefix of the earlier `solar` checkout. */
const PATH_RE = /(?:^|[\s(])(?:\/Users\/[\w.-]+\/dev\/\w+\/)?((?:docs|crates)\/[\w.\-/]+\.(?:pdf|zip|txt|md|xlsx|csv|json|html|rs))/;

export function locatorOf(citation: string): Locator {
  const url = URL_RE.exec(citation);
  if (url) {
    let value = url[0].replace(/[.,;:]+$/, "");
    const hash = value.indexOf("#");
    if (hash > 0) value = value.slice(0, hash);
    return { kind: "url", url: value };
  }
  const path = PATH_RE.exec(citation);
  if (path) return { kind: "path", path: path[1] };
  return { kind: "none" };
}

export function slug(text: string, max = 96): string {
  const s = text
    .toLowerCase()
    .replace(/%[0-9a-f]{2}/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > max ? s.slice(0, max).replace(/-+$/, "") : s;
}

/**
 * Assigns stable ids to sources across a whole import. Two citations of one locator share an
 * id; two locators that slug alike get numbered in first-seen order, which is deterministic
 * because the importer walks families and entries in a fixed order.
 */
export class SourceTable {
  private readonly byKey = new Map<string, Source>();
  private readonly ids = new Set<string>();

  idFor(citation: string): string {
    const locator = locatorOf(citation);
    const key = locator.kind === "url" ? `url:${locator.url}` : locator.kind === "path" ? `path:${locator.path}` : `text:${citation}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.id;
    const base =
      locator.kind === "url"
        ? slug(locator.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\.(pdf|html?|php|aspx?)$/i, ""))
        : locator.kind === "path"
          ? slug(locator.path.replace(/^docs\//, "").replace(/\.[a-z]+$/, ""))
          : slug(citation, 60);
    let id = base || "untitled";
    for (let n = 2; this.ids.has(id); n += 1) id = `${base}-${n}`;
    this.ids.add(id);
    const source: Source = { id };
    if (locator.kind === "url") source.url = locator.url;
    if (locator.kind === "path") source.path = locator.path;
    this.byKey.set(key, source);
    return id;
  }

  all(): Source[] {
    return [...this.byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

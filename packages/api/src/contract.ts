import { z } from "zod";

/**
 * What a consumer Worker sees of a release. Every method here is served by the `EquipmentApi`
 * entrypoint of the offgrid-equipment Worker over a service binding; nothing is public HTTP.
 * A consumer binds one turn to one `Release` and takes every answer and citation from it.
 */

/** The kinds a model may be, pinned here so the contract carries no other package. The repository's build checks the list against its schema. */
export const KINDS = [
  "charge-controller",
  "inverter",
  "inverter-charger",
  "battery",
  "bms",
  "shunt-monitor",
  "panel",
  "generator",
  "meter",
  "dc-dc-converter",
  "ac-charger",
  "balance-of-system",
  "pump",
  "appliance",
  "load",
  "jump-starter",
  "out-of-scope",
] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

/** A release is named by the sha256 the Worker gave its publication. */
export const ReleaseId = z.string().regex(/^[a-f0-9]{64}$/);
export type ReleaseId = z.infer<typeof ReleaseId>;

export const ModelId = z.string().min(1).max(160);
export type ModelId = z.infer<typeof ModelId>;
export const SourceId = z.string().min(1).max(200);
export type SourceId = z.infer<typeof SourceId>;
export const PropertyKey = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/);
export type PropertyKey = z.infer<typeof PropertyKey>;

/** The version of this contract. A consumer refuses a release whose contract it does not know. */
export const CONTRACT = 1 as const;

/** The most a single answer carries. A list cut to fit says so in `truncated`; nothing is quietly shorter. */
export const LIMITS = {
  /** Models one bundle may cover. */
  bundleModels: 8,
  /** Items a search page may hold, and the default when the query asks for more. */
  searchPage: 100,
  /** Claims in one bundle, across its models. */
  bundleClaims: 2000,
  /** Protocol links in one bundle. */
  bundleProtocol: 64,
  /** Sources in one bundle or one `sources` answer. */
  sources: 256,
  /** Candidates or near neighbours a resolution names. */
  candidates: 12,
} as const;

/** A model, as much of it as a lookup needs. */
export interface ModelSummary {
  id: ModelId;
  /** `record` for a model held in the repository, `feed` for a row a public dataset states. */
  tier: "record" | "feed";
  manufacturer: { id?: string; name: string };
  name: string;
  kind?: Kind;
  variant?: string;
  family?: string;
  aliases: string[];
  /** Set when a person confirmed the model; absent otherwise. */
  reviewedBy?: string;
}

export const ResolveQuery = z.union([
  z
    .object({
      brand: z.string().min(1).max(200).optional(),
      model: z.string().min(1).max(200),
      kind: Kind.optional(),
    })
    .strict(),
  /** A name read off a label or a photo, maker and model in whatever order they were printed. */
  z.object({ label: z.string().min(1).max(400) }).strict(),
]);
export type ResolveQuery = z.infer<typeof ResolveQuery>;

/**
 * `exact` is one model; `ambiguous` is more than one under the same key, for a consumer to ask
 * about; `none` carries near neighbours a consumer may show and must never pick.
 */
export type Resolution =
  | { outcome: "exact"; model: ModelSummary }
  | { outcome: "ambiguous"; candidates: ModelSummary[]; truncated: boolean }
  | { outcome: "none"; near: ModelSummary[]; truncated: boolean };

export const SearchQuery = z
  .object({
    brand: z.string().min(1).max(200).optional(),
    prefix: z.string().min(1).max(200).optional(),
    kind: Kind.optional(),
    limit: z.number().int().min(1).max(LIMITS.searchPage),
    cursor: z.string().max(400).optional(),
  })
  .strict();
export type SearchQuery = z.infer<typeof SearchQuery>;

export interface Page<T> {
  items: T[];
  /** Pass back to continue; absent when the page is the last. */
  cursor?: string;
  /** True when the query matched more than this page and the cursor is how to get it. */
  truncated: boolean;
}

/** One rated figure as the maker printed it. */
export interface Claim {
  id: string;
  model: ModelId;
  tier: "record" | "feed";
  name: string;
  english?: string;
  value: string;
  unit?: string;
  conditions?: string;
  source: SourceId;
  page?: number;
  confidence: "vendor-doc" | "community-crosschecked" | "community-single" | "unverified";
  extractedBy?: string;
  reviewedBy?: string;
  /** Why the figure would not be trusted for sizing anything, when something says so. */
  doubt?: string;
}

/** A validated reading of one claim under a canonical key (#82). Empty until the registry exists. */
export interface Property {
  model: ModelId;
  key: PropertyKey;
  value: number | { min: number; max: number } | string[];
  unit: string;
  conditions: Record<string, string | number>;
  claim: string;
  /** The rule and version, or the person, that mapped the claim to the key. */
  mappedBy: string;
  basis: "reviewed" | "extracted" | "feed";
}

/** A property a model's claims cannot fill, and why. */
export interface Gap {
  model: ModelId;
  key?: PropertyKey;
  reason: "no-registry" | "no-claim" | "unparsed" | "needs-conditions" | "conflict";
}

export interface DialectSummary {
  id: string;
  family: string;
  manufacturer?: string;
  confidence: "vendor-doc" | "community-crosschecked" | "community-single" | "unverified";
  refuter: string;
  transport?: string;
  blocks?: string;
  reports: string[];
  accepts: string[];
  gotchas: string[];
  sources: { source: SourceId; citation: string }[];
}

/** A model and a dialect it is known to speak, with what says so. */
export interface ProtocolLink {
  model: ModelId;
  dialect: DialectSummary;
  /** How the link was made. Absent for a link that predates evidence being recorded (#84). */
  evidence?: { kind: string; sources: { source: SourceId; citation: string }[] };
  confidence?: DialectSummary["confidence"];
}

export interface Source {
  id: SourceId;
  url?: string;
  path?: string;
  title?: string;
  publisher?: string;
  revision?: string;
  sha256?: string;
  retrievedAt?: string;
  redistributable?: boolean;
}

/** The ids one `sources` call may ask for: at most `LIMITS.sources`, so an answer is never quietly shorter than the question. */
export const SourcesQuery = z.array(SourceId).min(1).max(LIMITS.sources);
export type SourcesQuery = z.infer<typeof SourcesQuery>;

export const BundleQuery = z
  .object({
    models: z.array(ModelId).min(1).max(LIMITS.bundleModels),
    properties: z.array(PropertyKey).max(64).optional(),
    claims: z.boolean().optional(),
    protocol: z.boolean().optional(),
  })
  .strict();
export type BundleQuery = z.infer<typeof BundleQuery>;

/** Everything a turn needs about up to eight models, and exactly the sources those rows cite. */
export interface Bundle {
  release: ReleaseId;
  models: ModelSummary[];
  /** Model ids the query named that this release does not hold. */
  unknown: ModelId[];
  properties: Property[];
  gaps: Gap[];
  claims: Claim[];
  protocol: ProtocolLink[];
  sources: Source[];
  /** The lists that were cut to their limit: any of `claims`, `protocol`, `sources`. */
  truncated: ("claims" | "protocol" | "sources")[];
}

export interface PropertyDefinition {
  key: PropertyKey;
  quantity: string;
  unit: string;
  kinds: Kind[];
  conditions: string[];
  /** The reading this property limits, when it is a limit. */
  limits?: string;
}

/** What a release says about itself. */
export interface ReleaseInfo {
  id: ReleaseId;
  /** The sha256 of the release's file list: two releases with one content are the same dataset. */
  content: string;
  publishedAt: string;
  contract: typeof CONTRACT;
  counts: Record<string, number>;
}

/**
 * A handle bound to one release. Every answer, and every citation in it, comes from that release.
 * Only methods: over a service binding a property of an RPC target arrives as a promise, so the
 * release's id and contract come from `info()`, which a consumer checks once at the start of a turn.
 */
export interface Release {
  info(): Promise<ReleaseInfo>;
  resolve(q: ResolveQuery): Promise<Resolution>;
  search(q: SearchQuery): Promise<Page<ModelSummary>>;
  bundle(q: BundleQuery): Promise<Bundle>;
  /** Source records by id, at most `LIMITS.sources` a call; more is refused, never cut. */
  sources(ids: SourcesQuery): Promise<Source[]>;
  properties(): Promise<PropertyDefinition[]>;
}

/** The entrypoint a consumer binds: `release()` is the active release, `release(id)` a pinned one. */
export interface EquipmentApi {
  release(id?: ReleaseId): Promise<Release>;
}

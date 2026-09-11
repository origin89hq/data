import { BrandDecision } from "@origin89/equipment-schema/brand";
import {
  CommandKind,
  Confidence,
  DriverStatus,
  Family,
  MetricKind,
  RefuterStatus,
  Tier,
} from "@origin89/equipment-schema/enums";
import { EquipmentKind } from "@origin89/equipment-schema/guess";
import { LinkEvidenceKind } from "@origin89/equipment-schema/model";
import {
  Basis,
  GapReason,
  PropertyScope,
  PropertyStatus,
} from "@origin89/equipment-schema/properties";

/** How a dialect relates to a metric or command kind; `dialect_kinds.direction`. */
export const DIALECT_KIND_DIRECTIONS = ["reports", "accepts"] as const;
export type DialectKindDirection = (typeof DIALECT_KIND_DIRECTIONS)[number];

/** What a model key was built from; `model_keys.via`. */
export const MODEL_KEY_VIA = ["name", "alias"] as const;
export type ModelKeyVia = (typeof MODEL_KEY_VIA)[number];

/**
 * The closed vocabularies a consumer joins on, published as one file so nothing has to copy them
 * out of `packages/schema`. A firmware that names a dataset metric, a support list that names a
 * dialect family, or an assistant that filters on a tier reads the words from the release it is
 * pinned to, and a word outside the list is a mistake it can catch rather than a string it carries.
 */
export interface Vocabulary {
  /** What a dialect can report, the same names `dialect_kinds.kind` uses under `reports`. */
  metrics: string[];
  /** What a dialect accepts, the names under `accepts`. */
  commands: string[];
  /** What a model is; `models.kind`. */
  kinds: string[];
  /** How a dialect is filed; `dialects.family`. */
  families: string[];
  /** How much a protocol fact or a figure can be built on; `dialects.confidence`, `specs.confidence`. */
  confidence: string[];
  /** The catalogue legend for a driver; `dialects.driver_status`. */
  driverStatus: string[];
  /** Whether a second pass tried to refute a dialect; `dialects.refuter`. */
  refuter: string[];
  /** What a brand string turned out to be at the gate; `brands.decision`. */
  brandDecisions: string[];
  /** Where a model or figure row comes from; `models.tier`, `specs.tier`. */
  rowTiers: string[];
  /**
   * The catalogue's priority for a model named under a dialect, A to D; `dialect_models.tier`.
   * A different word for a different thing than a row's tier, so the two are listed apart.
   */
  dialectModelTiers: string[];
  /** What a normalized property rests on; `properties.basis`. */
  propertyBasis: string[];
  /** Why a model has no usable value for a property; `property_gaps.reason`. */
  propertyGapReasons: string[];
  /** Whether a property row is a value or one side of a conflict; `properties.status`. */
  propertyStatus: string[];
  /** Whether a figure is per input or for the whole unit; `properties.scope`. */
  propertyScopes: string[];
  /** Whether a dialect reports a kind or accepts it; `dialect_kinds.direction`. */
  dialectKindDirections: string[];
  /** Whether a model key came from the model's name or an alias; `model_keys.via`. */
  modelKeyVia: string[];
  /** How a model came to be linked to a dialect; `model_dialects.evidence_kind`. */
  linkEvidenceKinds: string[];
}

/** The vocabularies as the schemas declare them, in the schemas' own order. */
export function vocabulary(): Vocabulary {
  return {
    metrics: [...MetricKind.options],
    commands: [...CommandKind.options],
    kinds: [...EquipmentKind.options],
    families: [...Family.options],
    confidence: [...Confidence.options],
    driverStatus: [...DriverStatus.options],
    refuter: [...RefuterStatus.options],
    brandDecisions: [...BrandDecision.options],
    rowTiers: ["record", "feed"],
    dialectModelTiers: [...Tier.options],
    propertyBasis: [...Basis.options],
    propertyGapReasons: [...GapReason.options],
    propertyStatus: [...PropertyStatus.options],
    propertyScopes: [...PropertyScope.options],
    dialectKindDirections: [...DIALECT_KIND_DIRECTIONS],
    modelKeyVia: [...MODEL_KEY_VIA],
    linkEvidenceKinds: [...LinkEvidenceKind.options],
  };
}

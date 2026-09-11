import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  type Bundle,
  BundleQuery,
  type EquipmentApi as Contract,
  type ModelSummary,
  type Page,
  type PropertyDefinition,
  type Release,
  ReleaseId,
  type ReleaseInfo,
  type Resolution,
  ResolveQuery,
  SearchQuery,
  type Source,
  SourcesQuery,
} from "@origin89/equipment-api";
import {
  bundle,
  currentRelease,
  loadedRelease,
  properties,
  releaseInfo,
  resolve,
  search,
  sourcesById,
} from "./equipment-api.ts";
import type { Store } from "./release-store.ts";

/**
 * A handle bound to one release. Every method reads that release and no other, so a consumer
 * that takes one handle for a turn cannot mix two releases in one answer (#83).
 */
export class ReleaseHandle extends RpcTarget implements Release {
  constructor(
    private readonly db: Store,
    private readonly id: string,
  ) {
    super();
  }
  info(): Promise<ReleaseInfo> {
    return releaseInfo(this.db, this.id);
  }
  resolve(q: unknown): Promise<Resolution> {
    return resolve(this.db, this.id, ResolveQuery.parse(q));
  }
  search(q: unknown): Promise<Page<ModelSummary>> {
    return search(this.db, this.id, SearchQuery.parse(q));
  }
  bundle(q: unknown): Promise<Bundle> {
    return bundle(this.db, this.id, BundleQuery.parse(q));
  }
  sources(ids: unknown): Promise<Source[]> {
    return sourcesById(this.db, this.id, SourcesQuery.parse(ids));
  }
  async properties(): Promise<PropertyDefinition[]> {
    return properties();
  }
}

/**
 * The read-only entrypoint a consumer Worker binds by service binding, named `EquipmentApi`.
 * It has no HTTP surface: a `fetch` on the binding answers nothing, and the public routes of
 * the default export are unchanged.
 */
export class EquipmentApi extends WorkerEntrypoint<Env> implements Contract {
  async release(id?: unknown): Promise<ReleaseHandle> {
    const wanted = id === undefined ? undefined : ReleaseId.parse(id);
    const db = this.env.RELEASES;
    const chosen = wanted ? await loadedRelease(db, wanted) : await currentRelease(db);
    return new ReleaseHandle(db, chosen);
  }
}

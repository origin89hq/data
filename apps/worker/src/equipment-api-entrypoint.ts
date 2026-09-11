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
  ensureSchema,
  loadedRelease,
  properties,
  releaseInfo,
  resolve,
  search,
  sourcesById,
} from "./equipment-api.ts";
import { reloadPinned } from "./release-load.ts";
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
  /**
   * The release checked before every answer: retention may let a retained release go while a
   * handle to it is live, and it deletes the release row first, so a call after that gets
   * `NoSuchRelease` rather than an answer assembled from tables emptying behind it.
   */
  private async alive(): Promise<string> {
    return loadedRelease(this.db, this.id);
  }
  /**
   * An answer is read between two checks of the release: retention deletes the release row
   * before its tables, so a release let go while an answer was being assembled fails the second
   * check and the partial answer is not returned.
   */
  private async held<T>(answer: (release: string) => Promise<T>): Promise<T> {
    const out = await answer(await this.alive());
    await this.alive();
    return out;
  }
  info(): Promise<ReleaseInfo> {
    return this.held((release) => releaseInfo(this.db, release));
  }
  resolve(q: unknown): Promise<Resolution> {
    const query = ResolveQuery.parse(q);
    return this.held((release) => resolve(this.db, release, query));
  }
  search(q: unknown): Promise<Page<ModelSummary>> {
    const query = SearchQuery.parse(q);
    return this.held((release) => search(this.db, release, query));
  }
  bundle(q: unknown): Promise<Bundle> {
    const query = BundleQuery.parse(q);
    return this.held((release) => bundle(this.db, release, query));
  }
  sources(ids: unknown): Promise<Source[]> {
    const wanted = SourcesQuery.parse(ids);
    return this.held((release) => sourcesById(this.db, release, wanted));
  }
  properties(): Promise<PropertyDefinition[]> {
    return this.held(async () => properties());
  }
}

/**
 * Once per isolate before the first answer: the store's tables exist, and every pinned release
 * the store lacks has its load started, so a release pinned after retention let it go comes back.
 */
const preparations = new WeakMap<Store, Promise<void>>();
function prepared(env: Env): Promise<void> {
  const db = env.RELEASES;
  let pending = preparations.get(db);
  if (!pending) {
    pending = (async () => {
      await ensureSchema(db);
      await reloadPinned(env, db);
    })().catch((error) => {
      preparations.delete(db);
      throw error;
    });
    preparations.set(db, pending);
  }
  return pending;
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
    await prepared(this.env);
    const chosen = wanted ? await loadedRelease(db, wanted) : await currentRelease(db);
    return new ReleaseHandle(db, chosen);
  }
}

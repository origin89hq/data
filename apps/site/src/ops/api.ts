/** Member-only operations use the browser session; no tokens are stored in the page. */
export interface SellerState {
  seller: string;
  date?: string;
  sightings?: number;
  classified?: { parts: number; written: number };
}
/** How a plan's download was decided. The Worker leaves it out while the plan waits for somebody. */
export const DECISIONS = ["approved", "refused", "lapsed"] as const;
export type Decision = (typeof DECISIONS)[number];
export interface MakerState {
  maker: string;
  date?: string;
  offered?: number;
  approvedBy?: string;
  decision?: Decision;
  fetched?: number;
  sent?: number;
  converted?: number;
  read?: number;
  seeing?: number;
  seen?: number;
  specPages?: number;
  waitingOn: string;
}
export interface SupervisionReport {
  at: string;
  started: { what: string; entity: string; detail: string }[];
  blocked: { entity: string; waitingOn: string }[];
  concerns: string[];
}
export interface RunStatus {
  kind: "maker" | "seller";
  entity: string;
  run: string;
  date: string;
  instance: string;
  status: string;
  error: string | null;
}
export type Loaded<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "failed"; error: string };
export interface Pipeline {
  sellers: SellerState[];
  makers: MakerState[];
  runs: Map<string, RunStatus>;
  workflowError?: string;
  at: Date;
}
export interface DocumentPlan {
  manufacturer: string;
  checkedAt: string;
  documents: {
    url: string;
    host: string;
    bytes?: number;
    /** The page discovery found the link on, when it did. */
    foundOn?: string;
    /** Offered because a repository record cites it, whether or not the site led there. */
    cited?: true;
  }[];
}
export interface DatasetFile {
  name: string;
  rows?: number;
  bytes: number;
  sha256: string;
}
export class SessionError extends Error {}
class HttpError extends Error {
  status: number;
  constructor(status: number, detail?: string) {
    super(detail ?? `The request failed (${status}). Try again or check the service.`);
    this.status = status;
  }
}
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("The server returned an invalid object.");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string") throw Error("The server returned an invalid text field.");
  return value;
};
const number = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw Error("The server returned an invalid count.");
  return Number(value);
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw Error("The server returned an invalid list.");
  return value;
};
const date = (value: unknown): string => {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text))) throw Error("The server returned an invalid date.");
  return text;
};
const optionalText = (value: unknown) => (value === undefined ? undefined : string(value));
const optionalNumber = (value: unknown) => (value === undefined ? undefined : number(value));
const optionalDecision = (value: unknown): Decision | undefined => {
  if (value === undefined) return undefined;
  const known = DECISIONS.find((decision) => decision === value);
  if (!known) throw Error("The server returned an unknown download decision.");
  return known;
};

/** Abort stale reads, bound waiting, and refuse responses too large for the dashboard. */
export async function read(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000),
  });
  if (res.status === 401 || res.status === 403)
    throw new SessionError("Your session is unavailable. Sign in again to continue.");
  if (!res.body && !res.ok) throw new HttpError(res.status);
  if (!res.body) throw Error("The server returned no data.");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (!res.ok && bytes > 4096) throw new HttpError(res.status);
      if (bytes > 5 * 1024 * 1024)
        throw Error(
          "This response is too large to inspect here. Use the archive download instead.",
        );
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  const text =
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = object(JSON.parse(text));
      if (typeof body.error === "string" && body.error.length <= 1000) detail = body.error;
    } catch {}
    throw new HttpError(res.status, detail);
  }
  if (!text.trim()) throw Error("No file was found for this run.");
  return JSON.parse(text);
}
export async function whoami(signal?: AbortSignal): Promise<string> {
  return string(object(await read("/auth/me", signal)).login);
}
export function parseSupervision(value: unknown): SupervisionReport {
  const row = object(value);
  return {
    at: date(row.at),
    started: array(row.started).map((value) => {
      const item = object(value);
      return { what: string(item.what), entity: string(item.entity), detail: string(item.detail) };
    }),
    blocked: array(row.blocked).map((value) => {
      const item = object(value);
      return { entity: string(item.entity), waitingOn: string(item.waitingOn) };
    }),
    concerns: array(row.concerns).map(string),
  };
}
export async function supervision(signal?: AbortSignal): Promise<SupervisionReport | null> {
  try {
    return parseSupervision(await read("/supervision", signal));
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
export function parseState(value: unknown): Pick<Pipeline, "makers" | "sellers"> {
  const body = object(value);
  return {
    sellers: array(body.sellers).map((value) => {
      const row = object(value);
      const classified = row.classified === undefined ? undefined : object(row.classified);
      return {
        seller: string(row.seller),
        date: row.date === undefined ? undefined : date(row.date),
        sightings: optionalNumber(row.sightings),
        classified: classified
          ? { parts: number(classified.parts), written: number(classified.written) }
          : undefined,
      };
    }),
    makers: array(body.makers).map((value) => {
      const row = object(value);
      return {
        maker: string(row.maker),
        date: row.date === undefined ? undefined : date(row.date),
        waitingOn: string(row.waitingOn),
        approvedBy: optionalText(row.approvedBy),
        decision: optionalDecision(row.decision),
        offered: optionalNumber(row.offered),
        fetched: optionalNumber(row.fetched),
        sent: optionalNumber(row.sent),
        converted: optionalNumber(row.converted),
        read: optionalNumber(row.read),
        seeing: optionalNumber(row.seeing),
        seen: optionalNumber(row.seen),
        specPages: optionalNumber(row.specPages),
      };
    }),
  };
}
export function parseRuns(value: unknown): Map<string, RunStatus> {
  const rows = array(object(value).runs).map((value): RunStatus => {
    const row = object(value);
    if (row.kind !== "maker" && row.kind !== "seller") throw Error("Unknown run type.");
    return {
      kind: row.kind,
      entity: string(row.entity),
      run: string(row.run),
      date: date(row.date),
      instance: string(row.instance),
      status: string(row.status),
      error: row.error === null ? null : string(row.error),
    };
  });
  return new Map(rows.map((row) => [`${row.kind}:${row.entity}`, row]));
}
export async function pipeline(signal?: AbortSignal): Promise<Pipeline> {
  const [state, runs] = await Promise.allSettled([
    read("/state", signal).then(parseState),
    read("/runs", signal).then(parseRuns),
  ]);
  if (state.status === "rejected") throw state.reason;
  if (runs.status === "rejected" && runs.reason instanceof SessionError) throw runs.reason;
  return {
    ...state.value,
    runs: runs.status === "fulfilled" ? runs.value : new Map(),
    ...(runs.status === "rejected" ? { workflowError: message(runs.reason) } : {}),
    at: new Date(),
  };
}
export const archiveUrl = (prefix: string, list = false) =>
  `/archive?${new URLSearchParams({ prefix, ...(list ? { list: "true" } : {}) })}`;
const segment = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.includes(".."))
    throw Error("Invalid run identifier.");
  return value;
};
export function runPrefix(run: RunStatus): string {
  return `${run.kind === "maker" ? "documents" : "sightings"}/${segment(run.entity)}/runs/${segment(run.run)}`;
}
export async function assertCurrent(run: RunStatus, signal?: AbortSignal): Promise<void> {
  const root = run.kind === "maker" ? "documents" : "sightings";
  const current = object(
    await read(archiveUrl(`${root}/${segment(run.entity)}/current.json`), signal),
  );
  if (current.run !== run.run || current.instance !== run.instance)
    throw Error("The current run changed. Refresh the workspace and review the new run first.");
}
export function parsePlan(value: unknown, run: RunStatus): DocumentPlan {
  const row = object(value);
  if (row.manufacturer !== run.entity || row.checkedAt !== run.date)
    throw Error("This plan does not match the selected run.");
  return {
    manufacturer: string(row.manufacturer),
    checkedAt: date(row.checkedAt),
    documents: array(row.documents).map((value) => {
      const doc = object(value);
      const url = string(doc.url);
      const host = string(doc.host);
      const parsed = new URL(url);
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.hostname !== host ||
        parsed.username ||
        parsed.password
      )
        throw Error("The plan contains an invalid document URL.");
      if (doc.cited !== undefined && doc.cited !== true)
        throw Error("The plan marks a document as cited with something other than true.");
      return {
        url,
        host,
        bytes: optionalNumber(doc.bytes),
        ...(doc.foundOn === undefined ? {} : { foundOn: string(doc.foundOn) }),
        ...(doc.cited === true ? { cited: true as const } : {}),
      };
    }),
  };
}
export async function plan(run: RunStatus, signal?: AbortSignal): Promise<DocumentPlan> {
  await assertCurrent(run, signal);
  return parsePlan(await read(archiveUrl(`${runPrefix(run)}/plan.json`), signal), run);
}
export async function archive(run: RunStatus, signal?: AbortSignal): Promise<string[]> {
  const prefix = `${runPrefix(run)}/`;
  const body = object(await read(archiveUrl(prefix, true), signal));
  const keys = array(body.keys).map(string);
  if (keys.some((key) => !key.startsWith(prefix)))
    throw Error("The archive returned files outside this run.");
  return keys;
}
export async function approve(run: RunStatus, limit: number, documents: number): Promise<void> {
  if (run.kind !== "maker" || !Number.isSafeInteger(limit) || limit < 1 || limit > documents)
    throw Error("Choose a document limit within the reviewed plan.");
  await assertCurrent(run);
  await post(
    `/approve?${new URLSearchParams({ id: run.instance })}`,
    (body) => {
      if (body.sent !== true || body.to !== run.instance) throw Error("Unexpected approval.");
    },
    { approved: true, limit },
  );
}
/**
 * Whether the workflow has written this run's decision, asked a few times while it resumes.
 * `/approve` answers once the event is sent, before the workflow records what it decided, so one
 * refresh straight after could still show the run as waiting for somebody.
 */
export async function decisionRecorded(
  run: RunStatus,
  signal: AbortSignal,
  {
    tries = 10,
    everyMs = 2000,
    sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
  } = {},
): Promise<boolean> {
  const key = `${runPrefix(run)}/decision.json`;
  for (let attempt = 1; attempt <= tries && !signal.aborted; attempt += 1) {
    const listed = object(await read(archiveUrl(key, true), signal));
    if (array(listed.keys).includes(key)) return true;
    if (attempt < tries) await sleep(everyMs);
  }
  return false;
}
const UNCERTAIN_MUTATION =
  "The response could not be confirmed. The request may have been accepted. Refresh and inspect the run before trying again.";

async function post<T>(
  path: string,
  decode: (body: Record<string, unknown>) => T,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw Error(UNCERTAIN_MUTATION);
  }
  if (res.status === 401 || res.status === 403)
    throw new SessionError("Your session is unavailable. Sign in again to continue.");
  if (!res.ok) {
    const detail: unknown = await res.json().catch(() => null);
    const reason =
      detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string"
        ? detail.error.slice(0, 1000)
        : `The service answered ${res.status}.`;
    throw Error(`${reason} Refresh and inspect the run before trying again.`);
  }
  try {
    return decode(object(await res.json()));
  } catch {
    // Receiving 2xx headers does not prove that we received the acknowledgement. Body reads,
    // JSON decoding and endpoint-specific validation all happen after the mutation may commit.
    throw Error(UNCERTAIN_MUTATION);
  }
}
export function runSettingsError(
  kind: "maker" | "seller",
  entity: string,
  domains: string[],
  limit: number,
): string | undefined {
  try {
    segment(entity);
  } catch {
    return "Invalid run identifier.";
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    return "Choose a page limit from 1 to 500.";
  if (
    kind === "maker" &&
    (!domains.length ||
      domains.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)))
  )
    return "Enter the maker’s own domains, separated by commas, without https:// or paths.";
  return undefined;
}
export async function startRun(
  kind: "maker" | "seller",
  entity: string,
  domains: string[],
  limit: number,
  previous?: RunStatus,
): Promise<{ id: string; reconciled: boolean }> {
  const invalid = runSettingsError(kind, entity, domains, limit);
  if (invalid) throw Error(invalid);
  if (previous) {
    if (previous.kind !== kind || previous.entity !== entity)
      throw Error("The selected run does not match this entity.");
    await assertCurrent(previous);
  }
  const query =
    kind === "maker"
      ? new URLSearchParams({ id: entity, domains: domains.join(","), pages: String(limit) })
      : new URLSearchParams({ seller: entity, limit: String(limit) });
  return post(`${kind === "maker" ? "/maker" : "/run"}?${query}`, (body) => {
    const id = string(body.id);
    segment(id);
    if (body.outcome !== "created" && body.outcome !== "reconciled")
      throw Error("Unexpected run outcome.");
    return { id, reconciled: body.outcome === "reconciled" };
  });
}
export function parsePublished(value: unknown): DatasetFile[] {
  const files = object(object(value).files);
  return Object.entries(files).map(([name, value]) => {
    if (!/^[a-z0-9_]+\.(csv|parquet|json)$/.test(name))
      throw Error("The index contains an unsupported filename.");
    const row = object(value);
    const sha256 = string(row.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw Error("The index contains an invalid content hash.");
    // A table has rows; a file such as `vocabulary.json` has none to count, and the manifest
    // leaves the field out rather than write a number that measures nothing.
    return { name, rows: optionalNumber(row.rows), bytes: number(row.bytes), sha256 };
  });
}
export async function published(signal?: AbortSignal): Promise<DatasetFile[]> {
  return parsePublished(await read("/manifest.json", signal));
}

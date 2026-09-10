/**
 * What the runs page reads: the Worker's member routes, with the session cookie the browser holds.
 * Nothing here is public, and nothing is kept: every panel is what the archive says when it is
 * asked.
 */

/** Where one seller's week got to. Absent means not known yet, never zero. */
export interface SellerState {
  seller: string;
  date?: string;
  sightings?: number;
  classified?: { parts: number; written: number };
}

/** Where one maker got to, and what it is waiting for. */
export interface MakerState {
  maker: string;
  date?: string;
  offered?: number;
  approvedBy?: string;
  fetched?: number;
  sent?: number;
  converted?: number;
  read?: number;
  seen?: number;
  waitingOn: string;
}

export interface SupervisionReport {
  at: string;
  started: { what: string; entity: string; detail: string }[];
  blocked: { entity: string; waitingOn: string }[];
  concerns: string[];
}

/** The workflow behind one current run, as the Workflows service reports it. */
export interface RunStatus {
  kind: "maker" | "seller";
  entity: string;
  run: string;
  date: string;
  instance: string;
  status: string;
  error: string | null;
}

/** A panel's data: not asked for yet, on its way, there, or refused with the Worker's reason. */
export type Loaded<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "failed"; error: string };

/** The Worker's answer, or an error carrying what it said. A 401 means the session ran out. */
async function read(path: string): Promise<unknown> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const said =
      body !== null && typeof body === "object" && "error" in body ? String(body.error) : "";
    throw new Error(`${path} answered ${res.status}${said ? `: ${said}` : ""}`);
  }
  return body;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

export async function whoami(): Promise<string> {
  const body = await read("/auth/me");
  if (!isObject(body) || typeof body.login !== "string")
    throw new Error("the Worker did not say who is signed in");
  return body.login;
}

/** The supervisor's last pass, or nothing when it has never reported. */
export async function supervision(): Promise<SupervisionReport | null> {
  const res = await fetch("/supervision", { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/supervision answered ${res.status}`);
  const body: unknown = await res.json();
  if (
    !isObject(body) ||
    typeof body.at !== "string" ||
    !Array.isArray(body.started) ||
    !Array.isArray(body.blocked) ||
    !Array.isArray(body.concerns)
  )
    throw new Error("the supervisor's report is not in the shape this page reads");
  return body as unknown as SupervisionReport;
}

export interface Pipeline {
  sellers: SellerState[];
  makers: MakerState[];
  /** Workflow status by `kind:entity`. A run that recorded no instance has none. */
  runs: Map<string, RunStatus>;
  at: Date;
}

/** Every seller and maker, and the workflow behind each current run, asked at once. */
export async function pipeline(): Promise<Pipeline> {
  const [state, runs] = await Promise.all([read("/state"), read("/runs")]);
  if (!isObject(state) || !Array.isArray(state.sellers) || !Array.isArray(state.makers))
    throw new Error("/state is not in the shape this page reads");
  if (!isObject(runs) || !Array.isArray(runs.runs))
    throw new Error("/runs is not in the shape this page reads");
  return {
    sellers: state.sellers as SellerState[],
    makers: state.makers as MakerState[],
    runs: new Map((runs.runs as RunStatus[]).map((run) => [`${run.kind}:${run.entity}`, run])),
    at: new Date(),
  };
}

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AUDIENCE } from "../apps/worker/src/oidc.ts";

/**
 * What a tool sends the Worker to say who is asking.
 *
 * A GitHub Actions job sends a token GitHub issued to it, and the Worker decides what that
 * workflow may call. `just dev` keeps a control token in apps/worker/.dev.vars. A person working
 * against a deployment sends the GitHub token `just login` stored. OFFGRID_CONTROL_TOKEN, when
 * somebody sets it, comes before all of them.
 *
 * Usage: credential.ts <base url>   prints the token for that Worker, for the curl recipes
 */

const StoredLogin = z.object({
  token: z.string().min(1),
  login: z.string().min(1),
  /** The Worker that accepted the token. It is sent to no other. */
  origin: z.url(),
  expiresAt: z.iso.datetime(),
});
export type StoredLogin = z.infer<typeof StoredLogin>;

/** Where `just login` keeps its token: the user's config directory, readable by them alone. */
export function loginPath(): string {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "offgrid-equipment", "github-login.json");
}

/** The stored sign-in, or nothing when there is none. A file that is not one is an error. */
export function readLogin(): StoredLogin | undefined {
  let text: string;
  try {
    text = readFileSync(loginPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = StoredLogin.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${loginPath()} is not a sign-in; run just login`);
  return parsed.data;
}

export function saveLogin(login: StoredLogin): void {
  const path = loginPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  // The mode above applies only when the file is created. A token is not for other users to read.
  chmodSync(path, 0o600);
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Whether this runs in a GitHub Actions job that may ask GitHub for a job token. */
export function inActionsJob(): boolean {
  return Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
}

/**
 * A token GitHub issues to this job, naming its repository, branch and workflow. Asked for each
 * time it is needed, because one lasts minutes and a job can run for an hour.
 */
export async function jobToken(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const request = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !request) throw new Error("not in a GitHub Actions job with id-token: write");
  const asking = new URL(url);
  asking.searchParams.set("audience", AUDIENCE);
  const response = await fetch(asking, {
    headers: { authorization: `Bearer ${request}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub would not issue a job token: HTTP ${response.status}`);
  const body: unknown = await response.json();
  const value = typeof body === "object" && body !== null && "value" in body ? body.value : null;
  if (typeof value !== "string" || !value)
    throw new Error("GitHub answered a token request without a token");
  return value;
}

/** The bearer token for the Worker at `base`, or an error saying how to get one. */
export async function bearerFor(base: string, now: number = Date.now()): Promise<string> {
  const origin = secureOrigin(base);
  const configured = process.env.OFFGRID_CONTROL_TOKEN;
  if (configured) return configured;
  if (inActionsJob()) return jobToken();
  const local = LOCAL.test(base);
  if (local) {
    const token = devControlToken();
    if (token) return token;
  }
  const stored = readLogin();
  if (!stored)
    throw new Error(
      local
        ? "put CONTROL_TOKEN in apps/worker/.dev.vars, or sign in with: just login"
        : "sign in with: just login",
    );
  // A mistyped or borrowed OFFGRID_BASE_URL would otherwise receive a token the real Worker
  // accepts for hours.
  if (stored.origin !== origin)
    throw new Error(
      `the stored sign-in is for ${stored.origin}, not ${origin}; to use it, run: OFFGRID_BASE_URL=${origin} just login`,
    );
  if (Date.parse(stored.expiresAt) <= now)
    throw new Error(`the GitHub sign-in for ${stored.login} has expired; run: just login`);
  return stored.token;
}

/** Where a base URL points, as the stored sign-in records it. */
export function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    throw new Error(`${base || "the Worker's address"} is not a URL; check OFFGRID_BASE_URL`);
  }
}

const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where a token may go: HTTPS, or plain HTTP to this machine. Sent in the clear anywhere else, it
 * is readable by whoever carries it, and the Worker would take it for hours.
 */
export function secureOrigin(base: string): string {
  const origin = originOf(base);
  const { protocol, hostname } = new URL(origin);
  if (protocol === "https:" || (protocol === "http:" && LOOPBACK.has(hostname))) return origin;
  throw new Error(`${origin} is not HTTPS; a token goes only to https:// or to this machine`);
}

function devControlToken(): string | undefined {
  let vars: string;
  try {
    vars = readFileSync(new URL("../apps/worker/.dev.vars", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return /^CONTROL_TOKEN=(.*)$/m.exec(vars)?.[1]?.trim() || undefined;
}

if (import.meta.main) {
  try {
    console.log(await bearerFor(process.argv[2] ?? ""));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

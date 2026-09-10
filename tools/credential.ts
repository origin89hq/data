import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * What a tool sends the Worker to say who is asking.
 *
 * `just dev` keeps a control token in apps/worker/.dev.vars. A deployment takes the GitHub token
 * `just login` stored, and checks that its owner is in the working group. OFFGRID_CONTROL_TOKEN
 * still comes first when it is set, for the jobs that have not moved off it yet.
 *
 * Usage: credential.ts <base url>   prints the token for that Worker, for the curl recipes
 */

const StoredLogin = z.object({
  token: z.string().min(1),
  login: z.string().min(1),
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

/** The bearer token for the Worker at `base`, or an error saying how to get one. */
export function bearerFor(base: string, now: number = Date.now()): string {
  const configured = process.env.OFFGRID_CONTROL_TOKEN;
  if (configured) return configured;
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
  if (Date.parse(stored.expiresAt) <= now)
    throw new Error(`the GitHub sign-in for ${stored.login} has expired; run: just login`);
  return stored.token;
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
    console.log(bearerFor(process.argv[2] ?? ""));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

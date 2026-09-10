import { z } from "zod";
import { type StoredLogin, saveLogin } from "./credential.ts";

/**
 * Sign in with GitHub from a terminal.
 *
 * GitHub's device flow: this prints a code, you enter it at github.com/login/device, and GitHub
 * hands this a token for the origin89hq app. The Worker is then asked who that token belongs to,
 * so a sign-in that would be refused at every route is refused here instead, and the token is
 * kept only when it works. It lasts eight hours.
 *
 * Usage: login.ts   (OFFGRID_BASE_URL picks the Worker, as for every other recipe)
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** What GitHub's token lasts when it does not say. */
const TOKEN_SECONDS = 8 * 60 * 60;

const App = z.object({ clientId: z.string().min(1), org: z.string(), team: z.string() });
const Device = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
const Polled = z.union([
  z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().optional() }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
    interval: z.number().int().positive().optional(),
  }),
]);

export interface LoginOptions {
  base: string;
  /** Waits between polls. A test passes one that does not. */
  sleep?: (ms: number) => Promise<void>;
  say?: (line: string) => void;
  now?: () => number;
}

async function github(url: string, body: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // A refusal says why, as with a device flow the app has not turned on.
    const why =
      typeof answer === "object" && answer !== null
        ? ((answer as { error_description?: unknown; error?: unknown }).error_description ??
          (answer as { error?: unknown }).error)
        : undefined;
    throw new Error(`GitHub answered ${response.status}${why ? `: ${String(why)}` : ""}`);
  }
  return answer;
}

export async function login({
  base,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  say = console.log,
  now = Date.now,
}: LoginOptions): Promise<StoredLogin> {
  const described = await fetch(`${base}/auth/app`, { signal: AbortSignal.timeout(30_000) });
  const app = App.safeParse(described.ok ? await described.json() : null);
  if (!app.success)
    throw new Error(`${base}/auth/app answered ${described.status}; is sign-in configured there?`);
  const { clientId, org, team } = app.data;

  const device = Device.parse(
    await github("https://github.com/login/device/code", { client_id: clientId }),
  );
  say(`Open ${device.verification_uri} and enter ${device.user_code}`);

  let interval = device.interval;
  const deadline = now() + device.expires_in * 1000;
  let token: { value: string; seconds: number } | undefined;
  while (!token) {
    if (now() >= deadline)
      throw new Error("the code expired before it was entered; run just login again");
    await sleep(interval * 1000);
    const polled = Polled.parse(
      await github("https://github.com/login/oauth/access_token", {
        client_id: clientId,
        device_code: device.device_code,
        grant_type: DEVICE_GRANT,
      }),
    );
    if ("access_token" in polled) {
      token = { value: polled.access_token, seconds: polled.expires_in ?? TOKEN_SECONDS };
      break;
    }
    if (polled.error === "authorization_pending") continue;
    // GitHub asks for a longer wait and says how long; waiting less gets refused again.
    if (polled.error === "slow_down") {
      interval = polled.interval ?? interval + 5;
      continue;
    }
    if (polled.error === "expired_token")
      throw new Error("the code expired before it was entered; run just login again");
    if (polled.error === "access_denied") throw new Error("the sign-in was declined on GitHub");
    throw new Error(`GitHub refused the sign-in: ${polled.error_description ?? polled.error}`);
  }

  const me = await fetch(`${base}/auth/me`, {
    headers: { authorization: `Bearer ${token.value}` },
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await me.json().catch(() => ({}))) as { login?: unknown; error?: unknown };
  if (!me.ok || typeof answer.login !== "string")
    throw new Error(
      `signed in to GitHub, but ${base} refused: ${String(answer.error ?? me.status)}. Only members of ${org}/${team} get in.`,
    );
  const stored = {
    token: token.value,
    login: answer.login,
    expiresAt: new Date(now() + token.seconds * 1000).toISOString(),
  };
  saveLogin(stored);
  return stored;
}

if (import.meta.main) {
  const base = (process.env.OFFGRID_BASE_URL || "http://localhost:8790").replace(/\/$/, "");
  try {
    const signedIn = await login({ base });
    console.log(`Signed in as ${signedIn.login} until ${signedIn.expiresAt}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

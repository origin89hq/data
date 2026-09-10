import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { z } from "zod";
import { authorised, bearer, sameSecret } from "./authorised.ts";
import {
  type GitHubApp,
  GitHubUnavailable,
  type Membership,
  memberships,
  ORG,
  TEAM,
} from "./members.ts";

/**
 * Signing in with GitHub: a browser through `/auth/login`, a terminal through `just login`, and
 * what every control route asks of a request before it runs.
 */

type Env = Cloudflare.Env;

/** Who is calling a control route, as far as the Worker could establish. */
export type Caller = { kind: "member"; login: string } | { kind: "control token" };

export type Identified =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403 | 429 | 502; error: string };

/** Both cookies are `__Host-`: HTTPS only, this host only, the whole path. */
const SESSION = "offgrid-session";
const SIGN_IN = "offgrid-sign-in";
const COOKIE: CookieOptions = {
  prefix: "host",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
};
/** Long enough to sign in to GitHub, short enough that a stale half of a sign-in dies. */
const SIGN_IN_SECONDS = 600;
/** A GitHub App user token lasts eight hours, and the cookie holding it never outlives it. */
const SESSION_SECONDS = 8 * 60 * 60;

const SIGN_IN_HOW = "sign in with `just login`, or at /auth/login in a browser";

function githubApp(env: Env): GitHubApp | undefined {
  return env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
    : undefined;
}

/**
 * Whether a request may use the control routes, and who it is.
 *
 * A bearer token is either the control token, which only `just dev` sets, or a GitHub token from
 * `just login`. A browser carries the session cookie instead. A cookie goes with any request the
 * browser makes to this host, including one another site's page provoked, so a request that
 * changes something must also say it came from here.
 */
export async function identify<E extends { Bindings: Env }>(c: Context<E>): Promise<Identified> {
  if (await authorised(c.req.raw, c.env.CONTROL_TOKEN))
    return { ok: true, caller: { kind: "control token" } };
  const token = bearer(c.req.raw);
  const session = token ? undefined : getCookie(c, SESSION, "host");
  const presented = token ?? session;
  if (!presented) return { ok: false, status: 401, error: SIGN_IN_HOW };
  if (session && !sameOrigin(c))
    return { ok: false, status: 403, error: "a signed-in change from another site is refused" };
  const app = githubApp(c.env);
  if (!app)
    return {
      ok: false,
      status: 401,
      error: "not the control token, and GitHub sign-in is not configured on this Worker",
    };
  try {
    const membership = await memberships.check(presented, app, () => ration(c));
    return membership.ok
      ? { ok: true, caller: { kind: "member", login: membership.login } }
      : { ok: false, status: membership.status, error: membership.reason };
  } catch (error) {
    if (error instanceof GitHubUnavailable) return { ok: false, status: 502, error: error.message };
    throw error;
  }
}

/**
 * Whether this caller may make the Worker ask GitHub something it has not asked before. Each such
 * question spends the app's allowance with GitHub, so they are rationed per address.
 */
async function ration<E extends { Bindings: Env }>(c: Context<E>): Promise<boolean> {
  const { success } = await c.env.SIGN_IN_CHECKS.limit({
    key: c.req.header("cf-connecting-ip") ?? "no address given",
  });
  return success;
}

/** A read carries no risk from another site. Anything else must name this origin. */
function sameOrigin<E extends { Bindings: Env }>(c: Context<E>): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  return c.req.header("origin") === new URL(c.req.url).origin;
}

/** Where to land after signing in: a path on this site, never somewhere else. */
export function landing(next: string | undefined): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

const callback = (c: Context<{ Bindings: Env }>) => `${new URL(c.req.url).origin}/auth/callback`;

/** Signing in and out. Public by necessity: these are how somebody without a session gets one. */
export const authRoutes = new Hono<{ Bindings: Env }>();

/** What `just login` needs to run GitHub's device flow against the same app. Not a secret. */
authRoutes.get("/auth/app", (c) =>
  c.env.GITHUB_CLIENT_ID
    ? c.json({ clientId: c.env.GITHUB_CLIENT_ID, org: ORG, team: TEAM })
    : c.json({ error: "GitHub sign-in is not configured on this Worker" }, 503),
);

authRoutes.get("/auth/login", (c) => {
  const app = githubApp(c.env);
  if (!app) return c.text("GitHub sign-in is not configured on this Worker", 503);
  // The state ties GitHub's answer to this browser, so nobody can finish a sign-in they started
  // for somebody else.
  const state = crypto.randomUUID();
  setCookie(c, SIGN_IN, `${state}|${landing(c.req.query("next"))}`, {
    ...COOKIE,
    maxAge: SIGN_IN_SECONDS,
  });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: callback(c),
    state,
    allow_signup: "false",
  }).toString();
  return c.redirect(authorize.href, 302);
});

const Exchanged = z.union([
  z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().optional() }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

authRoutes.get("/auth/callback", async (c) => {
  const app = githubApp(c.env);
  if (!app) return c.text("GitHub sign-in is not configured on this Worker", 503);
  const started = getCookie(c, SIGN_IN, "host");
  deleteCookie(c, SIGN_IN, COOKIE);
  // The landing path may itself hold a "|"; the state never does.
  const cut = (started ?? "").indexOf("|");
  const expected = cut > 0 ? started?.slice(0, cut) : undefined;
  const next = cut > 0 ? started?.slice(cut + 1) : undefined;
  const state = c.req.query("state");
  if (!expected || !state || !(await sameSecret(state, expected)))
    return c.text(
      "This sign-in did not start in this browser, or took longer than ten minutes. Start again at /auth/login.",
      400,
    );
  const code = c.req.query("code");
  if (!code)
    return c.text(
      `GitHub did not sign you in: ${c.req.query("error") ?? "no code came back"}`,
      400,
    );
  if (!(await ration(c)))
    return c.text(
      "Too many sign-ins from here. Wait a minute, then start again at /auth/login.",
      429,
    );

  let answer: Response;
  try {
    answer = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "offgrid-equipment-worker",
      },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: callback(c),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return c.text(`GitHub did not answer: ${error instanceof Error ? error.message : error}`, 502);
  }
  const exchanged = Exchanged.safeParse(answer.ok ? await answer.json().catch(() => null) : null);
  if (!exchanged.success) return c.text(`GitHub answered the sign-in with ${answer.status}`, 502);
  // GitHub reports a spent or expired code with a 200 and an error field.
  if ("error" in exchanged.data)
    return c.text(
      `GitHub refused the sign-in: ${exchanged.data.error_description ?? exchanged.data.error}. Start again at /auth/login.`,
      400,
    );
  const { access_token: token, expires_in } = exchanged.data;

  let membership: Membership;
  try {
    membership = await memberships.check(token, app, () => ration(c));
  } catch (error) {
    if (error instanceof GitHubUnavailable) return c.text(error.message, 502);
    throw error;
  }
  if (!membership.ok)
    return c.text(
      `Signed in to GitHub, but ${membership.reason}. Only members of ${ORG}/${TEAM} can use this.`,
      membership.status,
    );
  setCookie(c, SESSION, token, {
    ...COOKIE,
    maxAge: Math.min(expires_in ?? SESSION_SECONDS, SESSION_SECONDS),
  });
  return c.redirect(landing(next), 302);
});

authRoutes.post("/auth/logout", (c) => {
  if (!sameOrigin(c)) return c.text("a sign-out from another site is refused", 403);
  deleteCookie(c, SESSION, COOKIE);
  return c.redirect("/", 303);
});

/** Who the Worker takes the caller to be. `just login` ends by asking. */
authRoutes.get("/auth/me", async (c) => {
  const who = await identify(c);
  if (!who.ok) return c.json({ error: who.error }, who.status);
  return c.json(
    who.caller.kind === "member" ? { login: who.caller.login } : { via: "the control token" },
  );
});

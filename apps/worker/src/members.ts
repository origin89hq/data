import { z } from "zod";

/**
 * Who may use the control routes: people signed in with GitHub, through the origin89hq GitHub App,
 * who are active members of the working-group team.
 *
 * The control token gave everyone who held it every route, and let them approve a download under
 * whatever name they typed. A GitHub identity is one person, the team is where membership is
 * decided, and the approver becomes the login GitHub vouches for.
 */

export const GITHUB_API = "https://api.github.com";
export const ORG = "origin89hq";
export const TEAM = "working-group";

/**
 * How long an answer about a token is trusted. Removing somebody from the team locks them out
 * within this, and in the meantime their requests do not each cost two calls to GitHub.
 */
export const MEMBERSHIP_TTL_MS = 5 * 60_000;
/** Answers kept at once, of each kind. Enough for every member's terminal and browser many times over. */
const REMEMBERED = 1000;
/** What GitHub prefixes a GitHub App's user tokens with. */
const USER_TOKEN_PREFIX = "ghu_";

/** GitHub's REST API refuses a request without a user agent. */
export const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "offgrid-equipment-worker",
} as const;

export interface GitHubApp {
  clientId: string;
  clientSecret: string;
}

export type Membership =
  | { ok: true; login: string }
  | { ok: false; status: 401 | 403 | 429; reason: string };

/** GitHub could not be asked, so there is no answer to give, and none is remembered. */
export class GitHubUnavailable extends Error {}

const TokenCheck = z.object({
  app: z.object({ client_id: z.string() }),
  user: z.object({ login: z.string() }).nullable(),
  expires_at: z.string().nullable().optional(),
});

const TeamMembership = z.object({ state: z.string() });

/** An answer from GitHub, and when the token it is about stops working, if GitHub said. */
interface Asked {
  answer: Membership;
  expiresAt?: number;
}

/**
 * Two answers GitHub gives about a token, remembered by the token's hash.
 *
 * Members and refusals are remembered apart. Every token the Worker has not seen costs calls to
 * GitHub, so made-up tokens could otherwise fill the memory and push members' answers out.
 */
export class Memberships {
  readonly #members = new Map<string, { answer: Membership; until: number }>();
  readonly #refusals = new Map<string, { answer: Membership; until: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Whether `token` is a user token this app issued, to an active member of the team.
   *
   * A token somebody gave another app, `gh`'s included, is refused: GitHub answers the first
   * question only for tokens issued to the app asking. `ration` is asked before GitHub is: an
   * answer not remembered spends the app's allowance with GitHub, which a caller sending made-up
   * tokens would otherwise use up for everybody.
   */
  async check(
    token: string,
    app: GitHubApp,
    ration: () => Promise<boolean> = async () => true,
  ): Promise<Membership> {
    const key = await digest(token);
    for (const remembered of [this.#members, this.#refusals]) {
      const entry = remembered.get(key);
      if (entry && entry.until > this.#now()) return entry.answer;
      remembered.delete(key);
    }
    if (!(await ration()))
      return { ok: false, status: 429, reason: "too many sign-in checks from here; wait a minute" };
    const { answer, expiresAt } = await this.#ask(token, app);
    // Never past the token's own end: a success remembered beyond it would outlive the token.
    const until = Math.min(this.#now() + MEMBERSHIP_TTL_MS, expiresAt ?? Number.POSITIVE_INFINITY);
    const remember = answer.ok ? this.#members : this.#refusals;
    if (remember.size >= REMEMBERED) {
      const oldest = remember.keys().next();
      if (!oldest.done) remember.delete(oldest.value);
    }
    remember.set(key, { answer, until });
    return answer;
  }

  async #ask(token: string, app: GitHubApp): Promise<Asked> {
    // Every GitHub App user token starts so. Anything else, `gh`'s own token or a string somebody
    // is trying, is refused here rather than spending the app's calls to GitHub on it.
    if (!token.startsWith(USER_TOKEN_PREFIX))
      return { answer: { ok: false, status: 401, reason: "not a GitHub App user token" } };
    const checked = await github(`/applications/${encodeURIComponent(app.clientId)}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
    });
    // 404 is GitHub's answer for a token this app did not issue, and for one that has expired.
    if (checked.status === 404 || checked.status === 422)
      return {
        answer: { ok: false, status: 401, reason: "not a token from this app, or it has expired" },
      };
    if (!checked.ok) throw new GitHubUnavailable(`GitHub's token check answered ${checked.status}`);
    const issued = TokenCheck.safeParse(await checked.json());
    if (!issued.success)
      throw new GitHubUnavailable("GitHub's token check answered in a new shape");
    const { app: issuer, user, expires_at } = issued.data;
    if (issuer.client_id !== app.clientId || !user)
      return { answer: { ok: false, status: 401, reason: "not a user token from this app" } };
    const expiresAt = expires_at ? Date.parse(expires_at) : undefined;
    if (expiresAt !== undefined && expiresAt <= this.#now())
      return { answer: { ok: false, status: 401, reason: "the token has expired; sign in again" } };

    const member = await github(
      `/orgs/${ORG}/teams/${TEAM}/memberships/${encodeURIComponent(user.login)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (member.status === 404)
      return {
        answer: { ok: false, status: 403, reason: `${user.login} is not in ${ORG}/${TEAM}` },
      };
    if (!member.ok) throw new GitHubUnavailable(`GitHub's team check answered ${member.status}`);
    const membership = TeamMembership.safeParse(await member.json());
    if (!membership.success)
      throw new GitHubUnavailable("GitHub's team check answered in a new shape");
    // An invitation not yet accepted is `pending`, and is not membership.
    if (membership.data.state !== "active")
      return {
        answer: {
          ok: false,
          status: 403,
          reason: `${user.login}'s membership of ${ORG}/${TEAM} is ${membership.data.state}`,
        },
      };
    return {
      answer: { ok: true, login: user.login },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
}

/** The one instance the Worker uses, so its answers outlive a request. */
export const memberships = new Memberships();

/** GitHub's REST API, bounded: a request that hangs holds a person's request with it. */
async function github(
  path: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: { ...GITHUB_HEADERS, ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new GitHubUnavailable(
      `GitHub did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function digest(token: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

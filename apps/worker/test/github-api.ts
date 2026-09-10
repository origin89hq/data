/**
 * GitHub, as far as signing in uses it: the app's token check, a team's memberships, and the
 * exchange of a sign-in code. Each test says which tokens exist, who they belong to, and who is on
 * the team, and reads back every call the Worker made.
 */
export const APP = { clientId: "Iv23test-client", clientSecret: "test-client-secret" };

export interface IssuedToken {
  login: string;
  /** The app GitHub issued it to. Another app's token is unknown to this app's token check. */
  clientId?: string;
  expiresAt?: string | null;
}

export interface GitHubWorld {
  tokens?: Record<string, IssuedToken>;
  /** Team membership state by login. Absent is not a member. */
  team?: Record<string, "active" | "pending">;
  /** Sign-in codes, and the token each is exchanged for. */
  codes?: Record<string, { token: string; expiresIn?: number }>;
  /** Answer every API call with this status, as GitHub does when it is down. */
  down?: number;
}

export function githubApi(world: GitHubWorld = {}) {
  const calls: {
    method: string;
    url: string;
    authorization: string | null;
    agent: string | null;
  }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      url: `${url.origin}${url.pathname}`,
      authorization: request.headers.get("authorization"),
      agent: request.headers.get("user-agent"),
    });
    if (world.down) return new Response("unavailable", { status: world.down });

    if (
      request.method === "POST" &&
      url.href === `https://api.github.com/applications/${APP.clientId}/token`
    ) {
      if (
        request.headers.get("authorization") !==
        `Basic ${btoa(`${APP.clientId}:${APP.clientSecret}`)}`
      )
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      const { access_token } = (await request.json()) as { access_token: string };
      const issued = world.tokens?.[access_token];
      if (!issued || (issued.clientId ?? APP.clientId) !== APP.clientId)
        return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({
        app: { client_id: APP.clientId, name: "Origin89 Data" },
        user: { login: issued.login, id: 1 },
        expires_at: issued.expiresAt ?? null,
      });
    }

    const member = /^\/orgs\/origin89hq\/teams\/working-group\/memberships\/([^/]+)$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && url.origin === "https://api.github.com" && member) {
      const state = world.team?.[decodeURIComponent(member[1])];
      return state
        ? Response.json({ state, role: "member" })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }

    if (request.method === "POST" && url.href === "https://github.com/login/oauth/access_token") {
      const { code, client_id, client_secret } = (await request.json()) as Record<string, string>;
      const exchanged = world.codes?.[code];
      if (client_id !== APP.clientId || client_secret !== APP.clientSecret)
        return Response.json({ error: "incorrect_client_credentials" });
      if (!exchanged)
        return Response.json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        });
      return Response.json({
        access_token: exchanged.token,
        token_type: "bearer",
        expires_in: exchanged.expiresIn ?? 28800,
      });
    }
    throw new Error(`the Worker fetched ${request.method} ${request.url}`);
  };
  return { fetch, calls };
}

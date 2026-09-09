/**
 * Every endpoint here starts a crawl, spends money on a model, or releases a download that a
 * person was supposed to approve. On a public URL that makes the gate decorative, so all of them
 * are behind one shared secret set with `wrangler secret put CONTROL_TOKEN`.
 */
export const AUTH_HEADER = "authorization";

/**
 * Compare in constant time. A plain `===` on a secret leaks its length and its matching prefix
 * through timing, and a token that can be guessed one byte at a time is not a token.
 */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // Digest first so the comparison is over two fixed-length values whatever the inputs were.
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(given)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0 && given.length === expected.length;
}

/** The bearer token a request carried, or nothing. */
export function bearer(request: Request): string | undefined {
  const header = request.headers.get(AUTH_HEADER);
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1];
}

/**
 * Whether a request may act. A deployment with no token configured refuses everything rather
 * than allowing everything: an unset secret is the state a fresh deploy is in, and defaulting it
 * open is how a control plane ends up on the open web.
 */
export async function authorised(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const given = bearer(request);
  return given ? await sameSecret(given, expected) : false;
}

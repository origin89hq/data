import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AUDIENCE, GITHUB_ISSUER } from "../src/oidc.ts";

/**
 * A stand-in for GitHub's OIDC issuer: a key generated here, the key set that publishes it, and
 * tokens signed with it carrying the claims a job on main would carry. Each test changes the one
 * claim it is about.
 */
export const KID = "github-actions-test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
export const jwks = {
  keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }],
};

export const publishJob = {
  repository: "origin89hq/offgrid-equipment",
  repository_owner: "origin89hq",
  repository_owner_id: "313416861",
  repository_id: "1362856140",
  ref: "refs/heads/main",
  workflow_ref: "origin89hq/offgrid-equipment/.github/workflows/publish.yml@refs/heads/main",
  environment: "offgrid-equipment-production",
  event_name: "push",
  run_id: "17000000001",
  sha: "4c1f2d0e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
};

export interface Signing {
  issuer?: string;
  audience?: string;
  /** Seconds from now. Negative for a token that has already expired. */
  expiresIn?: number;
  key?: CryptoKey;
  kid?: string;
}

/** A job token with `claims` over the publish job's, signed as GitHub would sign it. */
export async function jobToken(
  claims: Record<string, unknown> = {},
  {
    issuer = GITHUB_ISSUER,
    audience = AUDIENCE,
    expiresIn = 300,
    key = privateKey,
    kid = KID,
  }: Signing = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...publishJob, ...claims })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now - 60)
    .setNotBefore(now - 60)
    .setExpirationTime(now + expiresIn)
    .sign(key);
}

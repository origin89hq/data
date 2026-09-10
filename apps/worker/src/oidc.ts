import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

/**
 * A GitHub Actions job proving which workflow it is, in place of a secret it would have to hold.
 *
 * Publishing used to run on a Cloudflare API token that could also deploy the Worker and write any
 * key in the bucket, stored where a workflow pushed on any branch could read it. A job asks GitHub
 * for a token instead, signed by GitHub, naming the repository, branch, workflow file and event
 * that asked, and good for minutes. Nothing long-lived is left to leak.
 */

/** Who signs the tokens a job can ask for. */
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

/** The audience a job asks for, so a token minted for some other service is refused here. */
export const AUDIENCE = "https://data.origin89.com";

/**
 * This repository and its owner by id. A name can be reused: a renamed repository, or a new one
 * created under the old name, carries the same name and different ids.
 */
const REPOSITORY = "origin89hq/offgrid-equipment";
const OWNER_ID = "313416861";
const REPOSITORY_ID = "1362856140";
const BRANCH = "refs/heads/main";
const ENVIRONMENT = "offgrid-equipment-production";

/** A pull request runs a workflow from its own branch, so only these events are accepted. */
const EVENTS: ReadonlySet<string> = new Set(["push", "workflow_dispatch"]);

/** Clocks disagree a little. Seconds either side of `exp` and `nbf`. */
const CLOCK_TOLERANCE = 30;

/**
 * GitHub's signing keys, fetched on first use and cached by the isolate. `jose` fetches again when
 * a token names a key it has not seen, which is how GitHub's key rotation reaches us.
 */
const githubKeys = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`));

/** The claims checked here. GitHub sets every one of them on a job's token. */
const JobClaims = z.object({
  repository_owner_id: z.string(),
  repository_id: z.string(),
  ref: z.string(),
  workflow_ref: z.string(),
  environment: z.string().optional(),
  event_name: z.string(),
  run_id: z.string(),
  sha: z.string(),
});

/** The job that asked, once its token has been checked. */
export interface WorkflowRun {
  workflowRef: string;
  runId: string;
  sha: string;
}

export type WorkflowCheck = { ok: true; run: WorkflowRun } | { ok: false; reason: string };

/**
 * Whether a token came from `workflow`, a file under `.github/workflows/`, running on main in this
 * repository and deploying to production.
 *
 * `keys` is GitHub's key set unless a test supplies its own.
 */
export async function verifyWorkflow(
  token: string,
  workflow: string,
  keys: JWTVerifyGetKey = githubKeys,
): Promise<WorkflowCheck> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_ISSUER,
      audience: AUDIENCE,
      // GitHub signs with RS256. Naming it is what refuses `alg: none` and a key-confusion swap.
      algorithms: ["RS256"],
      requiredClaims: ["exp", "nbf"],
      clockTolerance: CLOCK_TOLERANCE,
    }));
  } catch (error) {
    // A bad signature, an expired token, a key GitHub never published. A network failure reaching
    // GitHub is not the caller's fault and is not reported as though it were.
    if (error instanceof errors.JOSEError) return { ok: false, reason: error.message };
    throw error;
  }
  const claims = JobClaims.safeParse(payload);
  if (!claims.success) return { ok: false, reason: "the token is missing a claim GitHub sets" };
  const job = claims.data;
  const expected = {
    repository_owner_id: OWNER_ID,
    repository_id: REPOSITORY_ID,
    ref: BRANCH,
    workflow_ref: `${REPOSITORY}/.github/workflows/${workflow}@${BRANCH}`,
    environment: ENVIRONMENT,
  } as const;
  for (const claim of Object.keys(expected) as (keyof typeof expected)[]) {
    if (job[claim] !== expected[claim])
      return {
        ok: false,
        reason: `${claim} is ${job[claim] ?? "absent"}; this route needs ${expected[claim]}`,
      };
  }
  if (!EVENTS.has(job.event_name))
    return {
      ok: false,
      reason: `event_name is ${job.event_name}; this route needs push or workflow_dispatch`,
    };
  return { ok: true, run: { workflowRef: job.workflow_ref, runId: job.run_id, sha: job.sha } };
}

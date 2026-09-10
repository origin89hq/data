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

/** The environment the deploy and the publish run in, with the production secrets. */
export const PRODUCTION = "offgrid-equipment-production";

/** A workflow file on main in this repository, as `workflow_ref` names it. */
const WORKFLOW_REF =
  /^origin89hq\/offgrid-equipment\/\.github\/workflows\/([\w.-]+)@refs\/heads\/main$/;

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

/** A job on main in this repository, once its token has been checked. */
export interface Job {
  /** Its workflow's file under `.github/workflows/`. */
  workflow: string;
  event: string;
  environment?: string;
  runId: string;
  sha: string;
}

export type JobCheck = { ok: true; job: Job } | { ok: false; reason: string };

/**
 * Which workflow a route takes, and how it must have been started. A pull request is never among
 * the events: it runs a workflow as its own branch has it.
 */
export interface WorkflowRule {
  /** The file under `.github/workflows/`, on main. */
  workflow: string;
  events: readonly string[];
  /** The environment the job must run in, when the route needs one. */
  environment?: string;
}

/** GitHub's signing keys could not be had, so no token can be checked either way. */
export class GitHubKeysUnavailable extends Error {}

/**
 * Whether a token is GitHub's, for this Worker, from a job on main in this repository.
 *
 * `keys` is GitHub's key set unless a test supplies its own.
 */
export async function verifyJob(
  token: string,
  keys: JWTVerifyGetKey = githubKeys,
): Promise<JobCheck> {
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
    // GitHub's key set could not be fetched or read. That says nothing about the token, so it is
    // not answered as a refusal. `jose` raises its generic error only for a key-set response that
    // is not a 200 or not JSON.
    if (
      !(error instanceof errors.JOSEError) ||
      error instanceof errors.JWKSTimeout ||
      error instanceof errors.JWKSInvalid ||
      error.code === errors.JOSEError.code
    )
      throw new GitHubKeysUnavailable(
        `GitHub's signing keys could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    // A bad signature, an expired token, a key GitHub never published.
    return { ok: false, reason: error.message };
  }
  const claims = JobClaims.safeParse(payload);
  if (!claims.success) return { ok: false, reason: "the token is missing a claim GitHub sets" };
  const job = claims.data;
  if (job.repository_owner_id !== OWNER_ID)
    return { ok: false, reason: `repository_owner_id is ${job.repository_owner_id}; not ours` };
  if (job.repository_id !== REPOSITORY_ID)
    return { ok: false, reason: `repository_id is ${job.repository_id}; not ${REPOSITORY}` };
  if (job.ref !== BRANCH)
    return { ok: false, reason: `ref is ${job.ref}; only ${BRANCH} is taken` };
  const workflow = WORKFLOW_REF.exec(job.workflow_ref)?.[1];
  if (!workflow)
    return {
      ok: false,
      reason: `workflow_ref is ${job.workflow_ref}; not a workflow of ${REPOSITORY} on main`,
    };
  return {
    ok: true,
    job: {
      workflow,
      event: job.event_name,
      ...(job.environment === undefined ? {} : { environment: job.environment }),
      runId: job.run_id,
      sha: job.sha,
    },
  };
}

/** Whether a checked job is the workflow `rule` names, started as the rule allows. */
export function admits(rule: WorkflowRule, job: Job): { ok: true } | { ok: false; reason: string } {
  if (job.workflow !== rule.workflow)
    return {
      ok: false,
      reason: `the token is from ${job.workflow}; this route takes ${rule.workflow}`,
    };
  if (!rule.events.includes(job.event))
    return {
      ok: false,
      reason: `${job.workflow} was started by ${job.event}; this route takes ${rule.events.join(" or ")}`,
    };
  if (rule.environment !== undefined && job.environment !== rule.environment)
    return {
      ok: false,
      reason: `environment is ${job.environment ?? "absent"}; this route takes ${rule.environment}`,
    };
  return { ok: true };
}

export type WorkflowCheck = JobCheck;

/** Whether a token is from the job `rule` names. */
export async function verifyWorkflow(
  token: string,
  rule: WorkflowRule,
  keys: JWTVerifyGetKey = githubKeys,
): Promise<WorkflowCheck> {
  const checked = await verifyJob(token, keys);
  if (!checked.ok) return checked;
  const admitted = admits(rule, checked.job);
  return admitted.ok ? checked : admitted;
}

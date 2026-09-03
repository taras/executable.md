/**
 * Who is allowed to become this run's executor.
 *
 * A runner authenticates with a GitHub Actions OIDC token, and the owner
 * validates it before the connection is accepted and before an acquisition
 * exists. Everything checked here is an identity the deployment configured, and
 * the checks are on IDs rather than names: a repository can be renamed and an
 * owner can be renamed, so a check on `repository` would admit whoever holds
 * the name today.
 *
 * Nothing about the token survives the check. The raw JWT, the JWKS endpoint,
 * the claims this contract does not name, and the reason a signature failed are
 * all provider state: none of them reaches durable storage, a journal event, a
 * public value or an error message. What a refusal says is which category it
 * fell into, because that is what an operator can act on and what a test can
 * assert without pinning provider wording.
 */

/** What a deployment must state before any runner can be admitted. */
export interface AdmissionPolicy {
  readonly issuer: string;
  readonly audience: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly eventName: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  /** The immutable identity of the workflow allowed to execute this run. */
  readonly jobWorkflowRef: string;
  /** The exact build both sides must be. */
  readonly release: string;
}

/**
 * The claims this contract reads.
 *
 * Deliberately a closed set. A token carries far more than this, and reading a
 * claim here is what makes it part of the contract — so anything not named is
 * not consulted, cannot be depended on, and never leaves the verifier.
 */
export interface ActionsClaims {
  readonly iss: unknown;
  readonly aud: unknown;
  readonly repository_id: unknown;
  readonly repository_owner_id: unknown;
  readonly event_name: unknown;
  readonly workflow_ref: unknown;
  readonly workflow_sha: unknown;
  readonly job_workflow_ref: unknown;
}

/** Which part of the admission a token failed. */
export type AdmissionRefusal =
  | "token-absent"
  | "token-malformed"
  | "issuer"
  | "audience"
  | "repository-id"
  | "repository-owner-id"
  | "event-name"
  | "workflow-ref"
  | "workflow-sha"
  | "workflow-identity";

export class AdmissionError extends Error {
  override name = "AdmissionError";

  constructor(readonly refusal: AdmissionRefusal) {
    super(`this runner is not admitted to execute this run (${refusal})`);
  }
}

/** Compare one claim, naming the check rather than the values. */
function requireClaim(claim: unknown, expected: string, refusal: AdmissionRefusal): void {
  if (typeof claim !== "string" || claim !== expected) {
    throw new AdmissionError(refusal);
  }
}

/**
 * Hold verified claims to the configured policy.
 *
 * Takes claims a verifier already authenticated rather than a token, so this
 * module owns *which* claims decide and nothing about how a signature is
 * checked. A caller that has not verified a signature has not admitted
 * anything, whatever this returns.
 */
export function admitClaims(policy: AdmissionPolicy, claims: ActionsClaims): void {
  requireClaim(claims.iss, policy.issuer, "issuer");
  // `aud` may be a string or an array of them; only the exact configured
  // audience admits, and an array containing it is that audience.
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.some((value) => value === policy.audience)) {
    throw new AdmissionError("audience");
  }
  requireClaim(claims.repository_id, policy.repositoryId, "repository-id");
  requireClaim(claims.repository_owner_id, policy.repositoryOwnerId, "repository-owner-id");
  requireClaim(claims.event_name, policy.eventName, "event-name");
  requireClaim(claims.workflow_ref, policy.workflowRef, "workflow-ref");
  requireClaim(claims.workflow_sha, policy.workflowSha, "workflow-sha");
  requireClaim(claims.job_workflow_ref, policy.jobWorkflowRef, "workflow-identity");
}

/** Read a claim set out of a payload nothing has inspected yet. */
export function parseClaims(payload: unknown): ActionsClaims {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AdmissionError("token-malformed");
  }
  const members = payload as Record<string, unknown>;
  return {
    iss: members["iss"],
    aud: members["aud"],
    repository_id: members["repository_id"],
    repository_owner_id: members["repository_owner_id"],
    event_name: members["event_name"],
    workflow_ref: members["workflow_ref"],
    workflow_sha: members["workflow_sha"],
    job_workflow_ref: members["job_workflow_ref"],
  };
}

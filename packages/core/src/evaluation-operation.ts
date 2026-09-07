import type { Operation, Result } from "effection";
import type { ComponentInvocation, IdentityClaimant } from "./invocation-identity.ts";
import type { GeneratedObservationResult } from "./generated-xmd.ts";
import { EvaluationInfrastructureError } from "./evaluation-errors.ts";
import { captureEvaluationBounds } from "./evaluation-result.ts";
import type { EvaluationBounds } from "./evaluation-result.ts";

export type EvaluationCaptureOperation = (
  invocation: ComponentInvocation,
) => Operation<Result<GeneratedObservationResult>>;

/** Prepare bounded composition in the trusted identity-component factory. */
export function boundedEvaluation(
  claim: IdentityClaimant,
  bounds: EvaluationBounds,
): EvaluationCaptureOperation {
  const captured = captureEvaluationBounds(bounds);
  if (claim.prepareEvaluation === undefined) {
    throw new EvaluationInfrastructureError(
      "setup",
      new Error("This claimant offers no evaluation composition."),
    );
  }
  try {
    return claim.prepareEvaluation(captured);
  } catch (cause) {
    if (cause instanceof EvaluationInfrastructureError) {
      throw cause;
    }
    throw new EvaluationInfrastructureError("setup", cause);
  }
}

/** The existing generated-XMD failure base; not a recoverability marker. */
export class GeneratedXmdError extends Error {
  override name = "GeneratedXmdError";
}

/** A normalized refusal of candidate input, safe to present for correction. */
export class EvaluationCandidateError extends GeneratedXmdError {
  readonly type = "executablemd.core.evaluation-failure/v1";
  readonly kind = "candidate";
  override name = "EvaluationCandidateError";
  constructor(
    readonly code: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(reason, options);
  }
}

/** Exhaustion of a bound selected by the surrounding composition. */
export class EvaluationLimitError extends Error {
  readonly type = "executablemd.core.evaluation-failure/v1";
  readonly kind = "limit";
  override name = "EvaluationLimitError";
  constructor(
    readonly limit: "duration" | "output-bytes",
    options?: ErrorOptions,
  ) {
    super(
      limit === "duration"
        ? "The evaluation exceeded its duration limit."
        : "The rendered output exceeded its UTF-8 byte limit.",
      options,
    );
    this.name = limit === "duration" ? "EvaluationDurationError" : "EvaluationOutputLimitError";
  }
}

/** Retained information whose current identity cannot be established. */
export class EvaluationStaleError extends GeneratedXmdError {
  readonly type = "executablemd.core.evaluation-failure/v1";
  readonly kind = "stale";
  override name = "EvaluationStaleError";
}

/** A terminal failure, never candidate correction context. */
export class EvaluationInfrastructureError extends Error {
  readonly type = "executablemd.core.evaluation-failure/v1";
  readonly kind = "infrastructure";
  override name = "EvaluationInfrastructureError";
  constructor(
    readonly phase: "setup" | "runtime" | "cleanup" | "persistence",
    cause: unknown,
  ) {
    super(`Evaluation ${phase} failed.`, { cause });
    this.name = `EvaluationInfrastructureError:${phase}`;
  }
}

export type EvaluationFailureKind = "candidate" | "limit" | "stale" | "infrastructure";

/** Descriptive classification across loaded copies; never authority to recover. */
export function evaluationFailureKind(value: unknown): EvaluationFailureKind | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const type = Object.getOwnPropertyDescriptor(value, "type");
  const kind: unknown = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  if (type?.value !== "executablemd.core.evaluation-failure/v1") {
    return undefined;
  }
  return kind === "candidate" || kind === "limit" || kind === "stale" || kind === "infrastructure"
    ? kind
    : undefined;
}

import type { Operation, Result } from "effection";
import { Err, Ok } from "effection";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { CapturedProfile } from "./evaluation-profile.ts";
import type { SyntaxReference } from "./syntax-reference.ts";
import type { EvaluationBounds } from "./evaluation-result.ts";
import { EvaluationResultCapture } from "./evaluation-result.ts";
import type { CapturedAdmissionIdentity, GeneratedObservationResult } from "./generated-xmd.ts";
import { assertCapturedAdmission } from "./generated-xmd.ts";
import type { Json } from "./types.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { canonicalFingerprint } from "./canonical.ts";
import {
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
} from "./evaluation-errors.ts";

export interface EvaluationConfiguration {
  readonly owner: string;
  readonly bounds: EvaluationBounds;
}

export interface EvaluationEnvironment {
  readonly fingerprint: string;
  readonly configurations: readonly EvaluationConfiguration[];
  readonly admission: CapturedAdmissionIdentity;
}

export function evaluationEnvironment(
  configurations: readonly EvaluationConfiguration[],
  profile: CapturedProfile | undefined,
  syntax: SyntaxReference | undefined,
  root: Json,
): EvaluationEnvironment | undefined {
  if (configurations.length === 0) {
    return undefined;
  }
  if (profile === undefined || syntax?.identity === undefined) {
    throw new EvaluationInfrastructureError(
      "setup",
      new Error("Bounded evaluation requires an identified profile and documentation reference."),
    );
  }
  if (
    profile.read.some(
      (entry) => entry.kind === "capability" && ["File", "Glob"].includes(entry.name),
    ) &&
    profile.filesIdentity === undefined
  ) {
    throw new EvaluationInfrastructureError(
      "setup",
      new Error("Bounded file reads require a filesystem scope and policy identity."),
    );
  }
  const admission: CapturedAdmissionIdentity = {
    allow: ["read"],
    workspace: profile.workspace !== undefined,
    allowed: profile.read.map((entry) => ({
      name: entry.name,
      identity: { kind: entry.kind, ...entry.identity },
      forms: entry.forms,
    })),
    requests: profile.read.flatMap((entry) => entry.requests ?? []),
  };
  const fingerprint = canonicalFingerprint(
    parseJson({
      format: 1,
      root,
      admission,
      configurations,
      reference: syntax.identity,
      filesystem: profile.filesIdentity ?? null,
      deprecatedSourceAlias: profile.deprecatedSourceAlias,
      read: profile.read.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        identity: entry.identity,
        forms: entry.forms,
        props: entry.props,
        returns: entry.definition.returns ?? null,
        requests: entry.requests ?? [],
        protectedOrigin: entry.protectedOrigin ?? null,
      })),
    }),
  );
  return Object.freeze({ fingerprint, configurations, admission });
}

const ENVIRONMENT = "evaluation_environment";
export const EVALUATION_STAGE = "evaluation_stage";

export function* persistEvaluationEnvironment(
  environment: EvaluationEnvironment | undefined,
): Operation<void> {
  if (environment === undefined) {
    return;
  }
  const value: unknown = yield createDurableOperation(
    { type: ENVIRONMENT, name: "evaluation" },
    function* () {
      return { version: 1, fingerprint: environment.fingerprint };
    },
  );
  if (!environmentRecord(value, environment)) {
    throw stale();
  }
}

function stale(cause?: unknown): EvaluationStaleError {
  return new EvaluationStaleError(
    "The retained evaluation record is malformed or its identity changed.",
    { cause },
  );
}

function environmentRecord(
  value: unknown,
  environment: EvaluationEnvironment | undefined,
): boolean {
  const record = parseJson(value);
  return (
    environment !== undefined &&
    isJsonObject(record) &&
    Object.keys(record).sort().join(",") === "fingerprint,version" &&
    record.version === 1 &&
    record.fingerprint === environment.fingerprint
  );
}

/** Execution-owned admission, run on the immutable journal before any root fast path. */
export function admitEvaluationHistory(
  events: readonly DurableEvent[],
  environment: EvaluationEnvironment | undefined,
): void {
  try {
    const manifests = events.filter(
      (event) => event.type === "yield" && event.description.type === ENVIRONMENT,
    );
    const stages = events.filter(
      (event) => event.type === "yield" && event.description.type === EVALUATION_STAGE,
    );
    if (
      manifests.length > 1 ||
      (manifests.length === 0 &&
        (stages.length > 0 ||
          (environment !== undefined && events.some((event) => event.type === "close"))))
    ) {
      throw stale();
    }
    for (const manifest of manifests) {
      if (
        manifest.type !== "yield" ||
        manifest.result.status !== "ok" ||
        !environmentRecord(manifest.result.value, environment)
      ) {
        throw stale();
      }
    }
    const children = new Set<string>();
    const invocations = new Set<string>();
    for (const header of stages) {
      if (environment === undefined || header.type !== "yield" || header.result.status !== "ok") {
        throw stale();
      }
      const value = parseJson(header.result.value);
      const owner = header.description.owner;
      const configuration = environment.configurations.find((entry) => entry.owner === owner);
      if (
        !isJsonObject(value) ||
        Object.keys(value).join(",") !== "child" ||
        typeof value.child !== "string" ||
        !value.child.startsWith(`${header.coroutineId}.`) ||
        configuration === undefined ||
        Object.keys(header.description).sort().join(",") !== "name,owner,type" ||
        children.has(value.child) ||
        invocations.has(header.description.name)
      ) {
        throw stale();
      }
      children.add(value.child);
      invocations.add(header.description.name);
      const closes = events.filter(
        (event) => event.type === "close" && event.coroutineId === value.child,
      );
      if (
        closes.length > 1 ||
        (closes.length === 0 &&
          events.some(
            (event) => event.type === "close" && event.coroutineId === header.coroutineId,
          ))
      ) {
        throw stale();
      }
      for (const close of closes) {
        if (close.result.status !== "ok") {
          throw stale();
        }
        const outcome = readEvaluationRecord(
          close.result.value,
          environment.fingerprint,
          header.description.name,
          configuration.bounds,
        );
        const record = parseJson(close.result.value);
        const child = value.child;
        const admissions = events.filter(
          (event) =>
            event.type === "yield" &&
            (event.coroutineId === child || event.coroutineId.startsWith(`${child}.`)) &&
            event.description.type === "generated_xmd",
        );
        if (outcome.ok) {
          if (
            admissions.length !== 1 ||
            !isJsonObject(record) ||
            typeof record.source !== "string"
          ) {
            throw stale();
          }
          const admission = admissions[0]!;
          if (admission.result.status !== "ok") {
            throw stale();
          }
          assertCapturedAdmission(admission.result.value, record.source, environment.admission);
        }
        for (const event of events) {
          if (
            event.type === "yield" &&
            (event.coroutineId === child || event.coroutineId.startsWith(`${child}.`)) &&
            event.description.type === "syntax_symbols"
          ) {
            if (event.result.status !== "ok") {
              throw stale();
            }
            const symbols = parseJson(event.result.value);
            if (
              !isJsonObject(symbols) ||
              Object.keys(symbols).join(",") !== "symbols" ||
              typeof symbols.symbols !== "string"
            ) {
              throw stale();
            }
          }
        }
      }
    }
    for (const event of events) {
      if (event.type === "close" && event.result.status === "ok") {
        const value = event.result.value;
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          "sourceIdentity" in value &&
          !children.has(event.coroutineId)
        ) {
          throw stale();
        }
      }
    }
  } catch (cause) {
    if (cause instanceof EvaluationStaleError) {
      throw cause;
    }
    throw stale(cause);
  }
}

export function evaluationRecord(
  fingerprint: string,
  invocation: string,
  source: string | null,
  outcome: Result<GeneratedObservationResult>,
): Json {
  return parseJson({
    version: 1,
    fingerprint,
    invocation,
    source,
    sourceIdentity: canonicalFingerprint({ invocation, source }),
    outcome: outcome.ok
      ? { status: "accepted", result: outcome.value }
      : {
          status: "refused",
          code:
            outcome.error instanceof EvaluationLimitError
              ? outcome.error.limit
              : outcome.error instanceof EvaluationCandidateError
                ? outcome.error.code
                : "invalid",
        },
  });
}

const candidateCodes = new Set([
  "block",
  "expression",
  "interpolation",
  "binding",
  "component",
  "content",
  "form",
  "construct",
  "request",
  "props",
  "syntax",
  "glob",
  "read",
  "parse",
  "authority",
]);

export function readEvaluationRecord(
  value: unknown,
  fingerprint: string,
  invocation: string,
  bounds: EvaluationBounds,
): Result<GeneratedObservationResult> {
  try {
    const record = parseJson(value);
    if (
      !isJsonObject(record) ||
      Object.keys(record).sort().join(",") !==
        "fingerprint,invocation,outcome,source,sourceIdentity,version" ||
      record.version !== 1 ||
      record.fingerprint !== fingerprint ||
      record.invocation !== invocation ||
      (record.source !== null && typeof record.source !== "string") ||
      !isJsonObject(record.outcome)
    ) {
      throw stale();
    }
    if (record.sourceIdentity !== canonicalFingerprint({ invocation, source: record.source })) {
      throw stale();
    }
    const outcome = record.outcome;
    if (outcome.status === "refused" && Object.keys(outcome).sort().join(",") === "code,status") {
      if (outcome.code === "duration" || outcome.code === "result-bytes") {
        return Err(new EvaluationLimitError(outcome.code));
      }
      if (typeof outcome.code === "string" && candidateCodes.has(outcome.code)) {
        return Err(
          new EvaluationCandidateError(outcome.code, "The generated request was refused."),
        );
      }
      throw stale();
    }
    if (
      outcome.status !== "accepted" ||
      record.source === null ||
      Object.keys(outcome).sort().join(",") !== "result,status" ||
      !isJsonObject(outcome.result)
    ) {
      throw stale();
    }
    const result = outcome.result;
    if (
      Object.keys(result).sort().join(",") !== "observations,output" ||
      typeof result.output !== "string" ||
      !Array.isArray(result.observations)
    ) {
      throw stale();
    }
    const capture = new EvaluationResultCapture(bounds.resultBytes);
    try {
      for (const observation of result.observations) {
        if (
          !isJsonObject(observation) ||
          Object.keys(observation).sort().join(",") !== "name,value" ||
          typeof observation.name !== "string"
        ) {
          throw stale();
        }
        capture.observation({ name: observation.name, value: observation.value });
      }
      capture.output(result.output);
      return Ok(capture.result());
    } finally {
      capture.close();
    }
  } catch (cause) {
    if (cause instanceof EvaluationStaleError) {
      throw cause;
    }
    throw stale(cause);
  }
}

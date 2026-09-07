import type { Operation } from "effection";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { CapturedProfile } from "./evaluation-profile.ts";
import type { SyntaxReference } from "./syntax-reference.ts";
import type { EvaluationBounds } from "./evaluation-result.ts";
import type { CapturedAdmissionIdentity } from "./generated-xmd.ts";
import { assertCapturedAdmission, assertRetainedGeneratedDecision } from "./generated-xmd.ts";
import type { Json } from "./types.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { canonicalFingerprint } from "./canonical.ts";
import { readSymbols } from "./components/Syntax.ts";
import { EvaluationInfrastructureError, EvaluationStaleError } from "./evaluation-errors.ts";

export interface EvaluationConfiguration {
  readonly owner: string;
  readonly bounds: EvaluationBounds;
}

export interface EvaluationEnvironment {
  readonly fingerprint: string;
  readonly configurations: readonly EvaluationConfiguration[];
  readonly admissions: readonly CapturedAdmissionIdentity[];
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
  const selections: ("read" | "write")[][] = [["read"], ["write"], ["read", "write"]];
  const admissions: CapturedAdmissionIdentity[] = selections.map((allow) => ({
    allow,
    workspace: profile.workspace !== undefined,
    allowed: [...profile.composition, ...allow.flatMap((effect) => profile[effect])].map(
      (entry) => ({
        name: entry.name,
        identity: { kind: entry.kind, ...entry.identity },
        forms: entry.forms,
      }),
    ),
    requests: allow.flatMap((effect) => profile[effect]).flatMap((entry) => entry.requests ?? []),
  }));
  const fingerprint = canonicalFingerprint(
    parseJson({
      format: 2,
      root,
      admissions,
      configurations,
      reference: syntax.identity,
      filesystem: profile.filesIdentity ?? null,
      deprecatedSourceAlias: profile.deprecatedSourceAlias,
      entries: [...profile.composition, ...profile.read, ...profile.write].map((entry) => ({
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
  return Object.freeze({ fingerprint, configurations, admissions });
}

const ENVIRONMENT = "evaluation_environment";

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

/** Identity-only admission runs before ordinary child or root replay can skip work. */
export function admitEvaluationHistory(
  events: readonly DurableEvent[],
  environment: EvaluationEnvironment | undefined,
): void {
  try {
    const manifests = events.filter(
      (event) => event.type === "yield" && event.description.type === ENVIRONMENT,
    );
    if (
      manifests.length > 1 ||
      (environment !== undefined &&
        manifests.length === 0 &&
        events.some((event) => event.type === "close"))
    ) {
      throw stale();
    }
    for (const event of events) {
      if (
        environment !== undefined &&
        event.type === "yield" &&
        event.description.type === "syntax_symbols" &&
        event.coroutineId.includes(".projection-") &&
        event.result.status === "ok"
      ) {
        const value = parseJson(event.result.value);
        if (
          readSymbols(value) === undefined &&
          !(
            isJsonObject(value) &&
            Object.keys(value).join(",") === "refusal" &&
            value.refusal === "syntax"
          )
        ) {
          throw stale();
        }
      }
      if (event.type === "yield" && event.description.type === "evaluation_stage") {
        throw stale();
      }
      if (
        event.type === "yield" &&
        event.description.type === ENVIRONMENT &&
        (event.result.status !== "ok" || !environmentRecord(event.result.value, environment))
      ) {
        throw stale();
      }
      if (
        environment !== undefined &&
        event.type === "yield" &&
        event.description.type === "generated_xmd"
      ) {
        if (event.result.status !== "ok") {
          throw stale();
        }
        const admitted = parseJson(event.result.value);
        assertRetainedGeneratedDecision(admitted);
        const candidate = parseJson(event.description.candidate);
        const policy = parseJson(event.description.input);
        if (
          !isJsonObject(admitted) ||
          !isJsonObject(candidate) ||
          !isJsonObject(policy) ||
          Object.keys(candidate).sort().join(",") !== "fingerprint,sourceHash" ||
          typeof candidate.sourceHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(candidate.sourceHash) ||
          candidate.fingerprint !==
            canonicalFingerprint({ sourceHash: candidate.sourceHash, policy })
        ) {
          throw stale();
        }
        const current = environment.admissions.find(
          (admission) => JSON.stringify(admission.allow) === JSON.stringify(policy.allow),
        );
        if (current === undefined) {
          throw stale();
        }
        // Refusals retain the same source/policy attestation as successful admissions.
        assertCapturedAdmission(
          { version: 2, decision: "admitted", source: "", named: [], policy },
          "",
          current,
        );
        if (admitted.decision === "admitted") {
          if (
            typeof admitted.source !== "string" ||
            canonicalFingerprint(admitted.source) !== candidate.sourceHash
          ) {
            throw stale();
          }
          assertCapturedAdmission(admitted, admitted.source, current);
          if (canonicalFingerprint(admitted.policy) !== canonicalFingerprint(policy)) {
            throw stale();
          }
        } else if (
          admitted.decision !== "refused" ||
          Object.keys(admitted).sort().join(",") !== "construct,decision,version" ||
          typeof admitted.construct !== "string"
        ) {
          throw stale();
        }
      }
      if (
        event.type === "close" &&
        event.coroutineId.includes(".projection-") &&
        event.result.status === "ok" &&
        typeof event.result.value !== "string"
      ) {
        throw stale();
      }
    }
  } catch (cause) {
    if (cause instanceof EvaluationStaleError) {
      throw cause;
    }
    throw stale(cause);
  }
}

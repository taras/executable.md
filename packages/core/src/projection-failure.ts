import { deserializeError } from "@executablemd/durable-streams";
import { CONSTRUCT } from "./generated-xmd.ts";
import { isJsonObject, parseJson } from "./json.ts";
import {
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
} from "./evaluation-errors.ts";

const NAME = "ExecutableMDProjectionFailure/v1";
const STALE = "The retained projection failure is malformed or inconsistent.";
const originals = new WeakMap<Error, Error>();

/** The complete allowed candidate contract, not a heuristic over a journal message. */
function candidateContracts(): { id: string; code: string; message: string }[] {
  return [
    ...Object.entries(CONSTRUCT).map(([code, message]) => ({
      id: `admission:${code}`,
      code,
      message,
    })),
    {
      id: "form",
      code: "form",
      message:
        "a generated element was admitted for one form and invoked as another. An admitted identity runs the form the element was written as, which is read from the invocation the engine issued rather than from anything composed around it.",
    },
    { id: "data", code: "expression", message: "The generated data expression is not admitted." },
    { id: "parse", code: "expression", message: "The generated data expression cannot be parsed." },
    {
      id: "binding",
      code: "binding",
      message: "The generated expression requires an unavailable local binding.",
    },
    { id: "props", code: "props", message: "The generated component props are not admitted." },
    { id: "read", code: "read", message: "An admitted file could not be read." },
    {
      id: "glob",
      code: "glob",
      message: "an admitted fragment could not search the working directory.",
    },
    {
      id: "syntax",
      code: "syntax",
      message: "The requested component documentation is not available.",
    },
  ];
}

/** Ordinary Error serialization carries this closed payload in the owner's Close(err). */
export function projectionFailure(error: Error, projection: string): Error {
  const candidate =
    error instanceof EvaluationCandidateError
      ? candidateContracts().find(
          (entry) => entry.code === error.code && entry.message === error.message,
        )
      : undefined;
  const failure =
    candidate !== undefined
      ? { kind: "candidate", code: candidate.id, diagnostic: candidate.message }
      : error instanceof EvaluationLimitError
        ? {
            kind: "limit",
            limit: error.limit,
            diagnostic: new EvaluationLimitError(error.limit).message,
          }
        : error instanceof EvaluationStaleError
          ? { kind: "stale", diagnostic: STALE }
          : {
              kind: "infrastructure",
              phase: error instanceof EvaluationInfrastructureError ? error.phase : "runtime",
            };
  const wrapped = new Error(JSON.stringify({ version: 1, projection, ...failure }));
  wrapped.name = NAME;
  wrapped.stack = "";
  originals.set(
    wrapped,
    candidate === undefined && error instanceof EvaluationCandidateError
      ? new EvaluationInfrastructureError("runtime", error)
      : error,
  );
  return wrapped;
}

export function liveProjectionFailure(error: unknown): unknown {
  return error instanceof Error ? (originals.get(error) ?? error) : error;
}

export function retainedProjectionFailure(value: unknown, projection: string): Error {
  try {
    const record = parseJson(value);
    if (
      !isJsonObject(record) ||
      Object.keys(record).sort().join(",") !== "message,name,stack" ||
      record.name !== NAME ||
      record.stack !== "" ||
      typeof record.message !== "string"
    ) {
      throw new Error();
    }
    const payload = parseJson(JSON.parse(record.message));
    if (
      !isJsonObject(payload) ||
      payload.version !== 1 ||
      payload.projection !== projection ||
      record.message !== JSON.stringify(payload)
    ) {
      throw new Error();
    }
    const fields = Object.keys(payload).sort().join(",");
    const cause = deserializeError({ name: NAME, message: record.message, stack: "" });
    if (payload.kind === "candidate" && fields === "code,diagnostic,kind,projection,version") {
      const contract = candidateContracts().find((entry) => entry.id === payload.code);
      if (contract === undefined || payload.diagnostic !== contract.message) {
        throw new Error();
      }
      return new EvaluationCandidateError(contract.code, contract.message, { cause });
    }
    if (
      payload.kind === "limit" &&
      fields === "diagnostic,kind,limit,projection,version" &&
      (payload.limit === "duration" || payload.limit === "output-bytes")
    ) {
      const error = new EvaluationLimitError(payload.limit, { cause });
      if (payload.diagnostic !== error.message) {
        throw new Error();
      }
      return error;
    }
    if (
      payload.kind === "stale" &&
      fields === "diagnostic,kind,projection,version" &&
      payload.diagnostic === STALE
    ) {
      return new EvaluationStaleError(STALE, { cause });
    }
    if (
      payload.kind === "infrastructure" &&
      fields === "kind,phase,projection,version" &&
      (payload.phase === "setup" ||
        payload.phase === "runtime" ||
        payload.phase === "cleanup" ||
        payload.phase === "persistence")
    ) {
      return new EvaluationInfrastructureError(payload.phase, cause);
    }
    throw new Error();
  } catch (cause) {
    throw new EvaluationStaleError(STALE, { cause });
  }
}

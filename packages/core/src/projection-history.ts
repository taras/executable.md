import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { EvaluationEnvironment } from "./evaluation-records.ts";
import { EvaluationStaleError } from "./evaluation-errors.ts";
import { canonicalFingerprint } from "./canonical.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { retainedProjectionFailure } from "./projection-failure.ts";

export const PROJECTION_ENTER = "projection_enter";

export function projectionId(root: string, invocation: string): string {
  return `${root}.projection-${canonicalFingerprint(invocation)}`;
}

function stale(cause?: unknown): never {
  throw new EvaluationStaleError("The retained projection ownership or settlement is invalid.", {
    cause,
  });
}

/** Detachment normally drops unknown Error members; validate these closes before it can. */
export function snapshotProjectionCloses(events: DurableEvent[]): DurableEvent[] {
  try {
    return events.map((event) => {
      const snapshot = { ...event };
      if (snapshot.type !== "close" || !/^.*\.projection-[^.]+$/.test(snapshot.coroutineId)) {
        return snapshot;
      }
      const parsed = parseDurableEvent(JSON.stringify(parseJson(snapshot)));
      if (!parsed.ok) {
        return stale(parsed.error);
      }
      return parsed.value;
    });
  } catch (cause) {
    return stale(cause);
  }
}

export function validateProjectionHistory(
  events: readonly DurableEvent[],
  environment: EvaluationEnvironment | undefined,
  root: string,
): void {
  const owners = new Set<string>();
  const closed = new Set<string>();
  for (const event of events) {
    if (event.type === "yield" && event.description.type === PROJECTION_ENTER) {
      if (
        environment === undefined ||
        event.result.status !== "ok" ||
        Object.keys(event.description).sort().join(",") !== "name,type"
      ) {
        stale();
      }
      const record = parseJson(event.result.value);
      if (
        !isJsonObject(record) ||
        Object.keys(record).sort().join(",") !== "component,environment,invocation,version" ||
        record.version !== 1 ||
        record.environment !== environment.fingerprint ||
        typeof record.invocation !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.invocation) ||
        !environment.configurations.some((entry) => entry.owner === record.component)
      ) {
        stale();
      }
      const child = projectionId(root, record.invocation);
      if (event.coroutineId !== child || event.description.name !== child || owners.has(child)) {
        stale();
      }
      owners.add(child);
    }
    if (!event.coroutineId.includes(".projection-")) {
      continue;
    }
    const child = event.coroutineId.split(".projection-")[1]?.split(".")[0];
    const owner = `${root}.projection-${child}`;
    if (
      child === undefined ||
      !/^[a-f0-9]{64}$/.test(child) ||
      !owners.has(owner) ||
      !(event.coroutineId === owner || event.coroutineId.startsWith(`${owner}.`))
    ) {
      stale();
    }
    if (event.type !== "close" || event.coroutineId !== owner) {
      continue;
    }
    if (closed.has(owner)) {
      stale();
    }
    closed.add(owner);
    if (event.result.status === "err") {
      retainedProjectionFailure(event.result.error, owner);
    } else if (event.result.status === "ok" && typeof event.result.value !== "string") {
      stale();
    }
  }
}

/** Reuse a root failure only when it agrees with a validated, owned child settlement. */
export function completedProjectionFailure(
  events: readonly DurableEvent[],
  root: string,
): Error | undefined {
  const close = events.find((event) => event.type === "close" && event.coroutineId === root);
  if (close?.type !== "close" || close.result.status === "cancelled") {
    return undefined;
  }
  const value =
    close.result.status === "err"
      ? { status: "err", error: parseJson(close.result.error) }
      : parseJson(close.result.value);
  if (!isJsonObject(value) || value.status !== "err" || !isJsonObject(value.error)) {
    return undefined;
  }
  for (const event of events) {
    if (
      event.type === "close" &&
      /^.*\.projection-[a-f0-9]{64}$/.test(event.coroutineId) &&
      event.result.status === "err"
    ) {
      const failure = retainedProjectionFailure(event.result.error, event.coroutineId);
      if (
        value.error.name === failure.name &&
        (failure instanceof EvaluationStaleError || value.error.message === failure.message)
      ) {
        return failure;
      }
    }
  }
  if (
    typeof value.error.name === "string" &&
    ["EvaluationCandidateError", "EvaluationDurationError", "EvaluationOutputLimitError"].includes(
      value.error.name,
    )
  ) {
    stale();
  }
  return undefined;
}

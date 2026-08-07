/**
 * The binding environment one eval block sees (spec §4.3).
 *
 * A block runs against a snapshot of the shared bindings taken when it starts,
 * and its declared exports are committed back when it finishes. It never holds
 * a live view of later blocks' changes, which is what lets persistent work keep
 * using the values — and the capabilities — it captured.
 *
 * `renderChildren`, `render` and `useContent` project content, and a projection
 * settles its errors under the error mode of the block that started it. A `persist
 * eval` block runs on the invocation's eval-scope loop task, created long before
 * that error mode existed, so the error mode cannot come from the surrounding context.
 * The snapshot carries ordinary closures bound to it instead.
 */

import type { ErrorMode } from "./errors.ts";
import type { EvalEnv, Json } from "./types.ts";

export function propsEnvironment(validatedProps: Record<string, Json>): EvalEnv {
  return { values: { props: validatedProps } };
}

/**
 * Layer an inner environment over an outer one while keeping the lexical
 * props namespace attached to projected content.
 */
export function layerEnvironments(
  outer: EvalEnv | undefined,
  inner: EvalEnv | undefined,
  preserveOuterProps = true,
): EvalEnv | undefined {
  if (outer === undefined) {
    return inner;
  }
  if (inner === undefined) {
    return outer;
  }

  const values = { ...outer.values, ...inner.values };
  if (preserveOuterProps && "props" in outer.values) {
    values.props = outer.values.props;
  }
  return { values };
}

export function layerProjectedContentEnvironment(
  caller: EvalEnv | undefined,
  authored: EvalEnv | undefined,
): EvalEnv | undefined {
  const callerProps =
    caller !== undefined && "props" in caller.values
      ? { values: { props: caller.values.props } }
      : undefined;
  return layerEnvironments(callerProps, authored);
}

/** Bindings the snapshot rebinds; the shared record holds the unbound originals. */
const PROJECTING = ["renderChildren", "render", "useContent"];

/** A projection binding as the expansion engine injects it. */
type Projector = (argument?: unknown, mode?: ErrorMode) => unknown;

function isProjector(value: unknown): value is Projector {
  return typeof value === "function";
}

/**
 * Snapshot `values` for one evaluation, with the projecting operations bound to
 * `mode`. The result is a plain object: writes the compiled block makes land
 * on it, not on the shared record, until `commitExports` publishes them.
 */
export function evaluationEnv(
  values: Record<string, unknown>,
  mode: ErrorMode,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...values };
  for (const name of PROJECTING) {
    const projector = snapshot[name];
    if (isProjector(projector)) {
      snapshot[name] = (argument?: unknown) => projector(argument, mode);
    }
  }
  return snapshot;
}

/**
 * Publish a completed evaluation's declared exports to the shared record.
 *
 * The journal carries only the JSON-serializable subset, so this is what keeps
 * a function or a live object usable by later blocks in the same run.
 */
export function commitExports(
  values: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  exports: string[],
): void {
  for (const name of exports) {
    if (name in snapshot) {
      values[name] = snapshot[name];
    }
  }
}

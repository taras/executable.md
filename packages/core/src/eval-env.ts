/**
 * The binding environment one eval block sees (spec §4.3).
 *
 * Blocks share one bindings record — that is what lets a later block read what
 * an earlier one exported. But `renderChildren`, `render` and `useContent`
 * project content, and a projection settles its errors under the policy of the
 * block that started it, which differs per block. A `persist eval` block runs
 * on the invocation's eval-scope loop task, created long before that policy
 * existed, so the policy cannot come from the surrounding context.
 *
 * Each evaluation therefore gets its own facade over the shared record: the
 * three projecting bindings are bound to that evaluation's policy, everything
 * else reads and writes straight through. Nothing is swapped and nothing is
 * restored, so concurrent evaluations cannot race and work that outlives its
 * block keeps calling the closures it was given.
 */

import type { ErrorPolicy } from "./errors.ts";

/**
 * Bindings the facade re-binds per evaluation. The shared record holds the
 * invocation's own versions, which carry no policy.
 */
const PROJECTING = ["renderChildren", "render", "useContent"];

/** A projection binding as it is injected into the shared record. */
type Projector = (argument?: unknown, policy?: ErrorPolicy) => unknown;

function isProjector(value: unknown): value is Projector {
  return typeof value === "function";
}

/**
 * Wrap `values` for one evaluation, binding the projecting operations to
 * `policy`. Reads of anything else, and every write, delete and enumeration,
 * reach the shared record — `serializeExports` and the transform's
 * `Object.keys` see exactly what they saw before.
 */
export function evaluationEnv(
  values: Record<string, unknown>,
  policy: ErrorPolicy,
): Record<string, unknown> {
  const bound = new Map<string, unknown>();

  return new Proxy(values, {
    get(target, key) {
      if (typeof key !== "string" || !PROJECTING.includes(key)) {
        return Reflect.get(target, key);
      }
      const existing = bound.get(key);
      if (existing) {
        return existing;
      }
      const projector = Reflect.get(target, key);
      if (!isProjector(projector)) {
        return projector;
      }
      const wrapper = (argument?: unknown) => projector(argument, policy);
      bound.set(key, wrapper);
      return wrapper;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
    deleteProperty(target, key) {
      return Reflect.deleteProperty(target, key);
    },
    has(target, key) {
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

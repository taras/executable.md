/** Invocation-local bindings reconstructed during live execution. */

import { Err, Ok, type Result } from "effection";
import { parse } from "acorn";
import type { EvalEnv, Json } from "./types.ts";

const LIVE_ENV = Symbol("@executablemd/core:live-env");
const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export interface LiveEnv {
  values: Record<string, unknown>;
}

export class InvalidServiceBindingError extends Error {
  override name = "InvalidServiceBindingError";
}

export class ServiceBindingCollisionError extends Error {
  override name = "ServiceBindingCollisionError";
}

export class LiveBindingCollisionError extends Error {
  override name = "LiveBindingCollisionError";
}

function isLiveEnv(value: unknown): value is LiveEnv {
  if (typeof value !== "object" || value === null || !("values" in value)) {
    return false;
  }
  return typeof value.values === "object" && value.values !== null && !Array.isArray(value.values);
}

function attach(env: EvalEnv, live: LiveEnv): void {
  Object.defineProperty(env, LIVE_ENV, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: live,
  });
}

/** The private live overlay owned by this durable environment. */
export function liveEnvironment(env: EvalEnv): LiveEnv {
  const attached = Reflect.get(env, LIVE_ENV);
  if (isLiveEnv(attached)) {
    return attached;
  }
  const live = { values: {} };
  attach(env, live);
  return live;
}

/** Make a derived durable environment share its source invocation's overlay. */
export function inheritLiveEnvironment(source: EvalEnv, derived: EvalEnv): EvalEnv {
  attach(derived, liveEnvironment(source));
  return derived;
}

export function derivedEnvironment(
  source: EvalEnv | undefined,
  values: Record<string, unknown>,
): EvalEnv {
  const derived = { values };
  return source === undefined ? derived : inheritLiveEnvironment(source, derived);
}

function isModuleBindingName(name: string): boolean {
  try {
    parse(`const { ${name} } = 0;`, { ecmaVersion: "latest", sourceType: "module" });
    return true;
  } catch {
    return false;
  }
}

export function validateBindingName(value: Json | undefined): Result<string | undefined> {
  if (value === undefined) {
    return Ok(undefined);
  }
  if (typeof value !== "string") {
    return Err(new Error("must be a non-empty string literal."));
  }
  if (value.length === 0) {
    return Err(new Error("must be non-empty."));
  }
  if (!IDENTIFIER_RE.test(value)) {
    return Err(new Error(`must be a valid JavaScript identifier. Got: "${value}"`));
  }
  if (!isModuleBindingName(value)) {
    return Err(new Error(`must be a valid JavaScript binding name. Got: "${value}"`));
  }
  return Ok(value);
}

/** Validate `service=<binding>` completely before the process is spawned. */
export function validateServiceBinding(
  candidate: string | undefined,
  durable: EvalEnv,
  live: LiveEnv,
): string {
  const result = validateBindingName(candidate);
  if (!result.ok || result.value === undefined) {
    throw new InvalidServiceBindingError(
      result.ok ? "service requires a binding name" : `service binding ${result.error.message}`,
    );
  }
  if (result.value in durable.values) {
    throw new ServiceBindingCollisionError(
      `service binding "${result.value}" collides with a durable binding`,
    );
  }
  if (result.value in live.values) {
    throw new ServiceBindingCollisionError(
      `service binding "${result.value}" collides with a live binding`,
    );
  }
  return result.value;
}

/** Refuse every export before an ephemeral block with a collision executes. */
export function validateLiveExports(exports: string[], durable: EvalEnv): void {
  const collision = exports.find((name) => name in durable.values);
  if (collision !== undefined) {
    throw new LiveBindingCollisionError(
      `ephemeral eval export "${collision}" collides with a durable binding`,
    );
  }
}

/** Refuse a durable operation before it can execute or restore a colliding export. */
export function validateDurableExports(exports: string[], live: LiveEnv): void {
  const collision = exports.find((name) => name in live.values);
  if (collision !== undefined) {
    throw new LiveBindingCollisionError(
      `durable eval export "${collision}" collides with a live binding`,
    );
  }
}

/** Refuse a durable value added after a live binding of the same name. */
export function validateLiveOverlay(durable: EvalEnv, live: LiveEnv): void {
  const collision = Object.keys(live.values).find((name) => name in durable.values);
  if (collision !== undefined) {
    throw new LiveBindingCollisionError(
      `live binding "${collision}" collides with a durable binding`,
    );
  }
}

/** Atomically publish a successful ephemeral evaluation's declared exports. */
export function commitLiveExports(
  live: LiveEnv,
  snapshot: Record<string, unknown>,
  exports: string[],
): void {
  const committed: Array<[string, unknown]> = [];
  for (const name of exports) {
    if (name in snapshot) {
      committed.push([name, snapshot[name]]);
    }
  }
  for (const [name, value] of committed) {
    live.values[name] = value;
  }
}

import { Err as effectionErr, Ok } from "effection";
import type { Operation, Result } from "effection";

function Err(reason: string): { failed: string } {
  return { failed: reason };
}

/** A local Err is a different function, whatever it is named. */
export function local(result: { ok: boolean; error: string }): { failed: string } | undefined {
  if (!result.ok) {
    return Err(result.error);
  }
  return undefined;
}

export function preserved(result: Result<number>): Result<string> {
  if (!result.ok) {
    return result;
  }
  return Ok(String(result.value));
}

/** A different error is a new failure, not the narrowed one rebuilt. */
export function replaced(result: Result<number>): Result<string> {
  if (!result.ok) {
    return effectionErr(new Error("could not read the configuration"));
  }
  return Ok(String(result.value));
}

/** The guard narrows one value; the rebuilt failure comes from another. */
export function unrelated(result: Result<number>, fallback: { error: Error }): Result<string> {
  if (!result.ok) {
    return effectionErr(fallback.error);
  }
  return Ok(String(result.value));
}

/** The return belongs to the inner operation, not to the guarded branch. */
export function deferred(result: Result<number>): () => Operation<Result<string>> {
  if (!result.ok) {
    return function* () {
      return effectionErr(result.error);
    };
  }
  return function* () {
    return Ok(String(result.value));
  };
}

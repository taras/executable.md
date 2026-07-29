import { Err, Ok } from "effection";
import type { Result } from "effection";

export function plain(result: Result<number>): Result<string> {
  if (!result.ok) {
    return Err(result.error);
  }
  return Ok(String(result.value));
}

export function nested(result: Result<number>, verbose: boolean): Result<string> {
  if (!result.ok) {
    if (verbose) {
      console.error(result.error.message);
    }
    return Err(result.error);
  }
  return Ok(String(result.value));
}

/** A property path is reported, but rewriting it is not mechanical. */
export function throughAProperty(state: { last: Result<number> }): Result<string> {
  if (!state.last.ok) {
    return Err(state.last.error);
  }
  return Ok(String(state.last.value));
}

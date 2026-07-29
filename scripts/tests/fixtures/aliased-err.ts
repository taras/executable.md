import { Err as failed, Ok } from "effection";
import * as effection from "effection";
import type { Result } from "effection";

export function aliased(result: Result<number>): Result<string> {
  if (!result.ok) {
    return failed(result.error);
  }
  return Ok(String(result.value));
}

export function namespaced(result: Result<number>): Result<string> {
  if (!result.ok) {
    return effection.Err(result.error);
  }
  return effection.Ok(String(result.value));
}

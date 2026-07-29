import { Err, Ok } from "effection";
import type { Result } from "effection";

export interface Route {
  host: string;
  port: number;
}

export type RouteResult = Result<Route>;

/** Discriminated on something other than an outcome. */
export type Token =
  | { kind: "literal"; text: string }
  | { kind: "capture"; name: string };

/** A turn either produced text or was cancelled — `ok` says nothing here. */
export type TurnResult = { cancelled: true } | { cancelled: false; text: string };

/** `ok` is not fixed to a literal, so the arms are not outcomes. */
export type Probe = { ok: boolean; at: number } | { pending: true };

/** One arm short of a result: nothing describes the failure. */
export type Halves = { ok: true; value: Route } | { value: Route };

export function readRoute(text: string): Result<Route> {
  const match = /^([^:]+):(\d+)$/.exec(text);
  if (!match) {
    return Err(new Error(`malformed route: ${text}`));
  }
  return Ok({ host: match[1]!, port: Number(match[2]) });
}

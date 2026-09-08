/**
 * What names a durable wait: its two effect types, and its identity.
 *
 * Their own module because they are names rather than behaviour, and the
 * modules that implement the behaviour reach a whole document runtime. A run's
 * owner has to recognize both effect types — a request is how it knows what a
 * run is waiting at, and an answer is what ends it — and an owner is not a
 * document runtime.
 */

import type { DurablePosition } from "@executablemd/durable-streams";
import { fingerprintOfValue } from "./fingerprint.ts";

/** The effect type one durable wait's request is retained under. */
export const SUSPENSION_REQUEST = "suspension_request";

/** The effect type one delivered answer is retained under. */
export const SUSPENSION_ANSWER = "suspension_answer";

/**
 * The opaque name one wait has, in this run, at this position.
 *
 * A digest rather than the three values joined, because the parts are a run
 * identifier a caller chose and a coroutine identifier with its own separators;
 * joined, two different triples could spell one string. It is opaque on
 * purpose: #300 will correlate an answer to it, and a correlation key that
 * revealed the position it came from would invite guessing a neighbouring wait.
 */
export function suspensionId(runId: string, position: DurablePosition): string {
  return fingerprintOfValue({
    runId,
    coroutineId: position.coroutineId,
    index: position.index,
  }).slice(0, 32);
}

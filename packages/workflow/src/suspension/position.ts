/**
 * Whether an execution is standing at the wait it says it is.
 *
 * Shared rather than any one host's, because every host that ends a wait asks
 * exactly this question and none of them may answer it differently. What
 * decides is position: a run's storage is reached the same way through the
 * neutral handle wherever it lives, and standing somewhere is not something a
 * caller can claim.
 */

import type { Operation } from "effection";
import { fingerprintOfValue } from "./fingerprint.ts";
import { durablePosition } from "@executablemd/durable-streams";
import type { EffectDescription } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { parseSuspensionRequest, type WorkflowSuspensionRequest } from "./api.ts";
import { SUSPENSION_REQUEST, suspensionId } from "./effects.ts";

/**
 * Whether this execution is, right now, at the wait it says it is.
 *
 * Authority is the *current* execution reaching its own request, not the
 * existence of a matching row. Retained history alone cannot decide this: on a
 * resume the request from the previous execution is already in the journal, so
 * a caller that ran before replay reached it could present its identifier and be
 * believed. What separates the real wait from that is where the execution is.
 *
 * `suspendFor()` publishes its request and then enters, so by the time it gets
 * here the coroutine has settled exactly one more durable yield than it had when
 * the request was made — the request's own. The identifier is therefore the one
 * this run derives for the position immediately behind this one, and a caller
 * standing anywhere else derives a different identifier and is refused.
 *
 * The journal is then read to confirm that the yield at that exact position is
 * this request, describing what is being presented. That is publication
 * evidence, and it is checked at one position rather than searched for.
 */
export function* atOwnRequest(
  database: WorkflowRunDatabase,
  suspension: string,
  request: WorkflowSuspensionRequest,
): Operation<string | undefined> {
  const position = yield* durablePosition();
  if (position.index === 0) {
    return NOT_AT_A_WAIT;
  }
  const published = {
    coroutineId: position.coroutineId,
    index: position.index - 1,
  };
  if (suspensionId(database.record.runId, published) !== suspension) {
    return NOT_AT_A_WAIT;
  }

  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    return NOT_AT_A_WAIT;
  }

  const counts = new Map<string, number>();
  let found: EffectDescription | undefined;
  for (const entry of entries.value) {
    if (entry.event.type !== "yield") {
      continue;
    }
    const coroutineId = entry.event.coroutineId;
    const index = counts.get(coroutineId) ?? 0;
    counts.set(coroutineId, index + 1);
    if (coroutineId === published.coroutineId && index === published.index) {
      found = entry.event.description;
    }
  }
  if (found === undefined || found.type !== SUSPENSION_REQUEST || found.name !== suspension) {
    return NOT_AT_A_WAIT;
  }
  // Parsed, not merely read. A retained description is journal data, and this
  // one is reached through a public durable operation any document can publish,
  // so what it holds is a claim about a request rather than a request. Comparing
  // raw fields would let a row that could never have come from `suspendFor()` —
  // a `responseSchema` that is an array, say — admit a wait whose schema nothing
  // could later validate an answer against.
  let retained: WorkflowSuspensionRequest;
  try {
    retained = parseSuspensionRequest({
      request: found.request,
      responseSchema: found.responseSchema,
    });
  } catch (error) {
    return (
      "the request retained at this position is not one a durable wait can be entered " +
      `for: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const same =
    fingerprintOfValue({
      request: request.request,
      responseSchema: request.responseSchema,
    }) ===
    fingerprintOfValue({
      request: retained.request,
      responseSchema: retained.responseSchema,
    });
  return same ? undefined : NOT_AT_A_WAIT;
}

export const NOT_AT_A_WAIT =
  "this execution is not at that durable wait. A wait is entered by the execution that has " +
  "just published its request, at the position that request was made — not by presenting an " +
  "identifier a run retains somewhere else.";

/**
 * The controller one execution suspends through.
 *
 * A durable wait is two facts that must not be confused. The document has
 * published a request — that is journal state, and `suspendFor()` owns it. The
 * *execution* must now end without a Close, its executor lock held until every
 * finalizer has run, and the run settled `suspended`. That second half is
 * lifecycle authority, and it belongs to whoever holds the lock.
 *
 * So this controller is the seam between them, and it is deliberately narrow:
 * it reports a wait to the lock owner and then does not return. It halts
 * nothing, settles nothing and writes nothing. The owner observes the notice as
 * one settlement candidate beside a canonical outcome and a foreground
 * interruption, and the owner is what tears the execution down.
 *
 * ## Why the operation never returns
 *
 * With no answer available — and #367 delivers none — there is nothing to
 * return, and returning anything would resume a document past a wait that never
 * ended. Raising would be worse: an ordinary error is something a document may
 * catch, and a caught suspension would leave a run executing past its own
 * suspension request. Remaining pending is what makes the halt the only way out
 * of the wait, and the halt is what leaves the root without a Close.
 *
 * ## The route composes; the position authorizes
 *
 * The controller is reached through a stable contextual name, so a component
 * carrying its own loaded copy of this package finds the controller the running
 * binary installed. That name is composition: middleware may refuse it for its
 * descendants, and nothing it returns is an answer.
 *
 * What authorizes entry is the retained request at the caller's exact current
 * durable position. Another durable operation can reproduce that request and
 * arrive there — replay identity is a type and a name, both public — and when it
 * does, it is standing at the same validated wait rather than at one of its own.
 *
 * There is deliberately nothing to hold and nothing to present. A capability
 * object has to be reachable to be used, and in this runtime anything reachable
 * by name is reachable by anyone who knows the name — which is selection, not
 * authority. Position is not like that: a caller cannot stand somewhere it is
 * not.
 */

import {
  call,
  ensure,
  type Operation,
  race,
  scoped,
  spawn,
  suspend,
  withResolvers,
} from "effection";
import { canonicalFingerprint } from "@executablemd/core";
import type { EffectDescription } from "@executablemd/durable-streams";
import {
  parseSuspensionRequest,
  WorkflowSuspension,
  type WorkflowSuspensionRequest,
} from "../suspension/api.ts";
import { durablePosition } from "@executablemd/durable-streams";
import { SUSPENSION_REQUEST, suspensionId } from "../suspension/suspend.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowRequestError } from "../storage/errors.ts";

/** What one execution reported it is waiting for. */
export interface SuspensionNotice {
  readonly suspensionId: string;
  readonly request: WorkflowSuspensionRequest;
}

export interface SuspensionControllerOptions {
  /**
   * The run whose retained request at the caller's position admits a wait.
   *
   * Read here rather than trusted from the caller: the identifier presented has
   * to be the one this run derives for the position immediately behind the
   * caller's own, and the yield there has to be that request.
   */
  readonly database: WorkflowRunDatabase;
}

export interface SuspensionController {
  /** Run `operation` as the execution this controller owns. */
  own<T>(operation: Operation<T>): Operation<T>;
  /** Settles once this execution reports a durable wait. */
  readonly notice: Operation<SuspensionNotice>;
  /** Whether this execution reported a durable wait. */
  reported(): boolean;
  /**
   * Whether this is the marker that ends a waiting execution.
   *
   * The marker leaves through the same path any other failure would, so a
   * finalizer that raises on the way out replaces it — which is exactly the
   * precedence a suspension needs. An execution that reported a wait and left
   * carrying something else did not reach that wait cleanly.
   */
  entered(error: unknown): boolean;
}

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
function* atOwnRequest(
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
    canonicalFingerprint({
      request: request.request,
      responseSchema: request.responseSchema,
    }) ===
    canonicalFingerprint({
      request: retained.request,
      responseSchema: retained.responseSchema,
    });
  return same ? undefined : NOT_AT_A_WAIT;
}

const NOT_AT_A_WAIT =
  "this execution is not at that durable wait. A wait is entered by the execution that has " +
  "just published its request, at the position that request was made — not by presenting an " +
  "identifier a run retains somewhere else.";

export function createSuspensionController(
  options: SuspensionControllerOptions,
): SuspensionController {
  const reported = withResolvers<SuspensionNotice>();
  // Private and one per controller: identity is what makes it this execution's
  // marker rather than a value anything else could produce.
  const marker = new Error("this execution is waiting durably");
  let seen: SuspensionNotice | undefined;

  return {
    notice: reported.operation,

    reported(): boolean {
      return seen !== undefined;
    },

    entered(error: unknown): boolean {
      return error === marker;
    },

    own<T>(operation: Operation<T>): Operation<T> {
      return scoped(function* () {
        function* accept(suspension: string, request: WorkflowSuspensionRequest): Operation<never> {
          const refused = yield* atOwnRequest(options.database, suspension, request);
          if (refused !== undefined) {
            throw new WorkflowRequestError(refused);
          }
          seen = { suspensionId: suspension, request };
          reported.resolve(seen);
          // The wait is the operation. The scope around it ends the execution;
          // nothing here returns or raises, so a document cannot catch its own
          // suspension and continue past it.
          yield* suspend();
          throw new WorkflowRequestError("a suspended execution resumed itself.");
        }

        yield* WorkflowSuspension.around(
          {
            *enter([suspension, request]): Operation<never> {
              return yield* accept(suspension, request);
            },
          },
          { at: "min" },
        );

        // Spawned rather than delegated, so the wait can be ended by halting
        // *the document* while this scope goes on to exit normally. That
        // distinction is the whole point: a halted scope swallows what its
        // finalizers raise, and a scope that exits normally does not — so every
        // finalizer out to the Workspace attachment reports its own failure to
        // whoever is deciding what this execution settled.
        const running = yield* spawn(() => operation);
        const outcome = yield* race([
          call(function* (): Operation<{ done: true; value: T } | { done: false }> {
            return { done: true, value: yield* running };
          }),
          call(function* (): Operation<{ done: true; value: T } | { done: false }> {
            yield* reported.operation;
            return { done: false };
          }),
        ]);
        if (outcome.done) {
          return outcome.value;
        }
        yield* running.halt();
        throw marker;
      });
    },
  };
}

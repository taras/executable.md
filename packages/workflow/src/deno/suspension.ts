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
 * ## Authority is the retained request
 *
 * `enter` accepts a suspension only when the run's own journal already holds the
 * request for it — as the most recent one, describing exactly what is being
 * presented, and under the identifier this run derives for the position that
 * request was published at. Every part of that comes from retained history and
 * the run record, both established before any document code ran.
 *
 * There is deliberately nothing to hold and nothing to present. A capability
 * object has to be reachable to be used, and in this runtime anything reachable
 * by name is reachable by anyone who knows the name — which is selection, not
 * authority. A caller cannot arrange for the journal to hold a request it did
 * not publish through the ordinary durable path, and cannot choose the
 * identifier that path derives, so there is nothing to forge.
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
import { WorkflowSuspension, type WorkflowSuspensionRequest } from "../suspension/api.ts";
import { SUSPENSION_REQUEST, suspensionId } from "../suspension/suspend.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowRequestError } from "../storage/errors.ts";

/** What one execution reported it is waiting for. */
export interface SuspensionNotice {
  readonly suspensionId: string;
  readonly request: WorkflowSuspensionRequest;
}

export interface SuspensionControllerOptions {
  /** The run whose retained history decides whether a wait may be entered. */
  readonly database: WorkflowRunDatabase;
  /**
   * Run while this execution is tearing down, for observing what a caller sees
   * mid-settlement.
   *
   * The barrier a live-suspension test needs is a moment, not a duration: the
   * notice has been reported, the halt is under way, the executor lock is still
   * held and no status has been published. That moment is exactly a finalizer,
   * so this is one — no sleep, no polling, and nothing that has to guess when
   * settlement is in flight. Provider-private, and it decides nothing: whatever
   * it observes, the settlement that follows is the ordinary one.
   */
  readonly duringTeardown?: () => Operation<void>;
  /**
   * Fail this execution's teardown, for proving what a failed teardown settles.
   *
   * Registered as an ordinary finalizer inside the execution scope, so the halt
   * that ends a suspension runs it exactly as it runs every other finalizer:
   * real structured teardown, failing where teardown actually happens. It is an
   * option on a provider-private constructor, absent from the workflow API and
   * unreachable from a document, and it grants nothing — a failing finalizer
   * cannot settle a run, publish a status or take a lock.
   */
  readonly failTeardown?: () => Error;
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
 * The request this run retained for `suspensionId`, if it retained one there.
 *
 * Three things are checked and each closes a different door. It must be the
 * most recent request, so an old wait cannot be re-entered. Its description must
 * match what is being presented, so a published request cannot be used to enter
 * a different wait. And its identifier must be the one this run derives for the
 * position it was published at, so publishing a request under a chosen name
 * proves nothing — the name has to be the one the position gives.
 */
function* publishedRequest(
  database: WorkflowRunDatabase,
  suspension: string,
  request: WorkflowSuspensionRequest,
): Operation<boolean> {
  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    return false;
  }

  const counts = new Map<string, number>();
  let found: { coroutineId: string; index: number; description: EffectDescription } | undefined;
  for (const entry of entries.value) {
    if (entry.event.type !== "yield") {
      continue;
    }
    const coroutineId = entry.event.coroutineId;
    const index = counts.get(coroutineId) ?? 0;
    counts.set(coroutineId, index + 1);
    if (entry.event.description.type === SUSPENSION_REQUEST) {
      found = { coroutineId, index, description: entry.event.description };
    }
  }
  if (found === undefined || found.description.name !== suspension) {
    return false;
  }
  if (
    canonicalFingerprint({
      request: request.request,
      responseSchema: request.responseSchema,
    }) !==
    canonicalFingerprint({
      request: found.description.request ?? null,
      responseSchema: found.description.responseSchema ?? null,
    })
  ) {
    return false;
  }
  return (
    suspensionId(database.record.runId, {
      coroutineId: found.coroutineId,
      index: found.index,
    }) === suspension
  );
}

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
        const failTeardown = options.failTeardown;
        if (failTeardown !== undefined) {
          yield* ensure(function* () {
            throw failTeardown();
          });
        }

        // Registered after the failing finalizer so it runs before it: an
        // observation of a teardown in flight must happen while the teardown is
        // still capable of succeeding.
        const duringTeardown = options.duringTeardown;
        if (duringTeardown !== undefined) {
          yield* ensure(duringTeardown);
        }

        yield* WorkflowSuspension.around(
          {
            *enter([suspension, request]): Operation<never> {
              if (!(yield* publishedRequest(options.database, suspension, request))) {
                throw new WorkflowRequestError(
                  "this run retains no suspension request under that identity, so there is no " +
                    "durable wait to enter. A wait is entered by publishing its request, and " +
                    "the identity is the one this run derives for where the request was made.",
                );
              }
              seen = { suspensionId: suspension, request };
              reported.resolve(seen);
              // The wait is the operation. The scope around it ends the
              // execution; nothing here returns or raises, so a document cannot
              // catch its own suspension and continue past it.
              yield* suspend();
              throw new WorkflowRequestError("a suspended execution resumed itself.");
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

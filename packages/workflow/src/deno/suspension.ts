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
 * ## Authority is the capability, not the shape
 *
 * `enter` accepts only a capability this controller issued, checked by object
 * identity in a `WeakSet` inside its own closure. Contextual selection decides
 * which controller answers; it never decides whether a caller may suspend. A
 * value shaped like a capability moves nothing.
 */

import { ensure, type Operation, scoped, suspend, withResolvers } from "effection";
import {
  type SuspensionCapability,
  WorkflowSuspension,
  type WorkflowSuspensionRequest,
} from "../suspension/api.ts";
import { CurrentSuspensionAuthority } from "../suspension/private.ts";
import { WorkflowRequestError } from "../storage/errors.ts";

/** What one execution reported it is waiting for. */
export interface SuspensionNotice {
  readonly suspensionId: string;
  readonly request: WorkflowSuspensionRequest;
}

export interface SuspensionControllerOptions {
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
  /**
   * What this execution's teardown raised, if it raised anything.
   *
   * Reported rather than thrown, because the owner ends a suspended execution
   * by halting it and a halt succeeds whether or not a destructor failed —
   * Effection treats halting as always effective, so a raise during teardown
   * unwinds the scope without reaching whoever asked for the halt. An owner
   * that must not claim `suspended` for an execution whose finalizers failed
   * therefore has to ask.
   */
  teardownFailure(): Error | undefined;
}

export function createSuspensionController(
  options: SuspensionControllerOptions = {},
): SuspensionController {
  const reported = withResolvers<SuspensionNotice>();
  const issued = new WeakSet<SuspensionCapability>();
  let failed: Error | undefined;

  return {
    notice: reported.operation,

    teardownFailure(): Error | undefined {
      return failed;
    },

    own<T>(operation: Operation<T>): Operation<T> {
      return scoped(function* () {
        const failTeardown = options.failTeardown;
        if (failTeardown !== undefined) {
          yield* ensure(function* () {
            const error = failTeardown();
            failed = error;
            throw error;
          });
        }

        // Registered after the failing finalizer so it runs before it: an
        // observation of a teardown in flight must happen while the teardown is
        // still capable of succeeding.
        const duringTeardown = options.duringTeardown;
        if (duringTeardown !== undefined) {
          yield* ensure(duringTeardown);
        }

        yield* CurrentSuspensionAuthority.set({
          capability(suspensionId: string): SuspensionCapability {
            const capability = Object.freeze({ suspensionId });
            issued.add(capability);
            return capability;
          },
        });

        yield* WorkflowSuspension.around(
          {
            *enter([capability, request]): Operation<never> {
              if (
                typeof capability !== "object" ||
                capability === null ||
                !issued.has(capability)
              ) {
                throw new WorkflowRequestError(
                  "the suspension capability is foreign or fabricated: only the capability this " +
                    "execution was issued may suspend it.",
                );
              }
              reported.resolve({ suspensionId: capability.suspensionId, request });
              // The wait is the operation. Whoever holds the executor lock ends
              // the execution around it.
              yield* suspend();
              throw new WorkflowRequestError("a suspended execution resumed itself.");
            },
          },
          { at: "min" },
        );

        return yield* operation;
      });
    },
  };
}

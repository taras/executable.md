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

import { call, type Operation, race, scoped, spawn, suspend, withResolvers } from "effection";
import {
  suspensionRequestFingerprint,
  WorkflowSuspension,
  type WorkflowSuspensionRequest,
} from "../suspension/api.ts";
import type { Json } from "@executablemd/durable-streams";
import {
  type SuspensionAnswerAuthority,
  type SuspensionAnswerProvider,
  useSuspensionAnswerProvider,
} from "../suspension/answer.ts";
import { atOwnRequest } from "../suspension/position.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowRequestError, WorkflowTransactionError } from "../storage/errors.ts";
import { consumeRetainedAnswer, readRetainedAnswer } from "./answers.ts";
import type { WorkflowRunConnections } from "./connections.ts";
import { hostConnections } from "./host-connections.ts";
import { withEnlistedJournalRoute } from "./journal-route.ts";
import { readTransaction } from "./reading.ts";

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
        // The run's retained delivery state is this host's, so the answer
        // provider is installed only where this host's registry is. A
        // controller running without one enters waits and never claims: an
        // execution with no way to reach retained state has no answers.
        const connections = yield* hostConnections();
        if (connections !== undefined) {
          yield* useSuspensionAnswerProvider(answerProvider(options.database, connections));
        }

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

/**
 * The owner of one run's retained delivery state.
 *
 * Two facts have to move together and only this host can move them: the answer
 * stops being pending, and the journal gains the event that says the wait ended.
 * So the transaction is opened here, the publication the durable operation
 * offered is routed into it, and the value is returned only once that
 * transaction has committed. A crash anywhere before the commit leaves the
 * answer pending and the wait unanswered, which is a run that can be resumed
 * again rather than one that has silently lost a value somebody delivered.
 */
function answerProvider(
  database: WorkflowRunDatabase,
  connections: WorkflowRunConnections,
): SuspensionAnswerProvider {
  return {
    *claim(authority: SuspensionAnswerAuthority): Operation<Json | undefined> {
      // Where the execution stands, before what the run retains. An execution
      // that is not at this wait has nothing to claim, and the public route
      // reports that refusal authoritatively a moment later.
      const refused = yield* atOwnRequest(database, authority.suspensionId, authority.request);
      if (refused !== undefined) {
        return undefined;
      }

      const connection = connections.validateLease(database).connection;
      const pending = yield* scoped(function* () {
        yield* connection.lock.hold();
        return readTransaction(connection.database, () =>
          readRetainedAnswer(connection.database, authority.suspensionId),
        );
      });
      if (pending === undefined || pending.state !== "pending") {
        return undefined;
      }

      connections.validateJournalProvenance(database, authority.journalProvenance);

      const claimed = yield* database.transact(function* (transaction) {
        const active = connections.authorizeTransaction(database, transaction);
        const writable = active.lease?.connection;
        if (writable === undefined) {
          throw new WorkflowTransactionError(
            "the answer claim is not bound to this active WorkflowRun transaction.",
          );
        }
        const token = connections.issueToken(database, transaction);

        // Read again under the write lock. What was pending a moment ago may
        // have been claimed by another execution, and the publication that
        // commits with the consumption has to be of the value that consumption
        // took.
        const retained = readRetainedAnswer(writable.database, authority.suspensionId);
        if (retained === undefined || retained.state !== "pending") {
          throw new WorkflowRequestError(
            `the answer retained for ${authority.suspensionId} was consumed by another ` +
              "execution before this one could publish it.",
          );
        }
        if (retained.requestFingerprint !== suspensionRequestFingerprint(authority.request)) {
          throw new WorkflowRequestError(
            `the answer retained for ${authority.suspensionId} was delivered against a ` +
              "different request, so it is not an answer to the wait this execution reached.",
          );
        }

        yield* withEnlistedJournalRoute(
          database,
          transaction,
          token,
          authority.publish(retained.answer),
        );

        if (
          !consumeRetainedAnswer(
            writable.database,
            authority.suspensionId,
            new Date().toISOString(),
          )
        ) {
          throw new WorkflowRequestError(
            `the answer retained for ${authority.suspensionId} could not be consumed, so its ` +
              "publication is discarded with this transaction.",
          );
        }
        return retained.answer;
      });
      if (!claimed.ok) {
        throw claimed.error;
      }
      return claimed.value;
    },
  };
}

/**
 * Ending a durable wait on a run whose owner is somewhere else.
 *
 * The delivered value is retained on the owner, and the event that answers the
 * wait is published on the owner, and the two have to happen together. Locally
 * that is one SQLite transaction. Here it is one commit: the execution reads
 * what the owner retains, publishes the answer into the transaction it is
 * already inside, and enlists the consumption beside it — so the owner receives
 * one proposal that appends the event and spends the row, and applies both or
 * neither.
 *
 * Nothing about that is a claim the runner gets to make. The owner holds the
 * value, checks the event against what it holds, and refuses a consumption
 * whose row is gone, spent, or delivered against a different request. What the
 * runner decides is only where its execution is standing.
 */

import { type Operation, scoped } from "effection";
import type { Json, JournalProvenance } from "@executablemd/durable-streams";
import { atOwnRequest } from "../suspension/position.ts";
import { suspensionRequestFingerprint } from "../suspension/api.ts";
import { SUSPENSION_REQUEST } from "../suspension/effects.ts";
import {
  type SuspensionAnswerAuthority,
  type SuspensionAnswerProvider,
  useSuspensionAnswerProvider,
} from "../suspension/answer.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowRequestError, WorkflowTransactionError } from "../storage/errors.ts";
import type { RemoteRetainedAnswer } from "./answer-link.ts";
import { activeWorkspaceRoute, type RemoteRunLink } from "./database.ts";
import { withRemoteJournalRoute } from "./journal-route.ts";

/** The one acquired run an answer may be claimed against. */
export interface RemoteAnsweredRun {
  /** The acquisition this run is reached through. */
  readonly link: RemoteRunLink;
  /** The handle the execution reads and transacts through. */
  readonly database: WorkflowRunDatabase;
  /** The witness taken over the exact journal this run publishes into. */
  readonly provenance: JournalProvenance;
}

/**
 * Install this run's answer provider for the current scope.
 *
 * Installed beside one acquired execution's run and closed with it. There is no
 * name to reach it by and no value to copy: registration is keyed by an opaque
 * selection this module hands the coordinator, so a fabricated one resolves to
 * nothing and a closed one stops resolving.
 */
export function* installRemoteSuspensionAnswers(run: RemoteAnsweredRun): Operation<void> {
  yield* useSuspensionAnswerProvider(remoteAnswerProvider(run));
}

function remoteAnswerProvider(run: RemoteAnsweredRun): SuspensionAnswerProvider {
  const { link, database } = run;
  return {
    *claim(authority: SuspensionAnswerAuthority): Operation<Json | undefined> {
      // Where the execution stands, before what the owner retains. An execution
      // that is not at this wait has nothing to claim, and asking the owner
      // about a wait this execution is not standing at would be asking it to
      // decide something only position can decide.
      const refused = yield* atOwnRequest(database, authority.suspensionId, authority.request);
      if (refused !== undefined) {
        return undefined;
      }

      // The event this run published the request as, read from the run's own
      // journal rather than derived. The owner compares it with what the run is
      // standing at, so a claim naming the wrong one is asking about a wait
      // rather than claiming this one.
      const requestEventId = yield* publishedRequest(database, authority.suspensionId);
      if (requestEventId === undefined) {
        return undefined;
      }
      const pending = yield* link.pendingAnswer(authority.suspensionId, requestEventId);
      if (!pending.ok) {
        throw pending.error;
      }
      if (pending.value === undefined || pending.value.state !== "pending") {
        // Nothing retained, or an answer this run already published. Either way
        // this wait is not ended by a delivery, and the wait itself follows.
        return undefined;
      }
      const retained = pending.value;
      if (retained.requestFingerprint !== suspensionRequestFingerprint(authority.request)) {
        // Retained against a different request. It is not an answer to the wait
        // this execution reached, whatever it is an answer to.
        return undefined;
      }

      const claimed = yield* database.transact(function* (transaction) {
        const route = yield* activeWorkspaceRoute(database, transaction);
        if (route === undefined) {
          throw new WorkflowTransactionError(
            "the answer claim is not bound to this active workflow run transaction.",
          );
        }
        // The provenance this coordinator was given has to be the journal this
        // transaction commits against. A publication routed anywhere else would
        // append its answer outside the transaction that spends the row.
        if (
          authority.journalProvenance === undefined ||
          authority.journalProvenance !== run.provenance
        ) {
          throw new WorkflowRequestError(
            "the live journal this answer would be published into does not have the " +
              "provenance of the selected remote run.",
          );
        }

        yield* withRemoteJournalRoute(database, transaction, authority.publish(retained.answer));
        // Named, not asserted: the owner reads what it retained, holds the
        // event this transaction appends to it, and spends the row in the same
        // transaction — or spends nothing and appends nothing.
        route.consume({
          suspensionId: retained.suspensionId,
          requestEventId: retained.requestEventId,
          requestFingerprint: retained.requestFingerprint,
        });
        return retained.answer;
      });
      if (!claimed.ok) {
        throw claimed.error;
      }
      // Only now. What proves the wait ended is the owner having committed the
      // transaction that appended the answer and spent the row — not that a
      // publication was offered inside it.
      return claimed.value;
    },
  };
}

/**
 * The journal event this run published one wait's request as.
 *
 * Read from the run's own history, so what the claim names is what the run
 * retains rather than something derived from the identifier it was given.
 */
function* publishedRequest(
  database: WorkflowRunDatabase,
  suspensionId: string,
): Operation<string | undefined> {
  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    return undefined;
  }
  const found = entries.value.find(
    (entry) =>
      entry.event.type === "yield" &&
      entry.event.description.type === SUSPENSION_REQUEST &&
      entry.event.description.name === suspensionId,
  );
  return found?.eventId;
}

/** Read one run's retained answer in a scope of its own. */
export function readRemoteAnswer(
  link: RemoteRunLink,
  suspensionId: string,
  requestEventId: string,
): Operation<RemoteRetainedAnswer | undefined> {
  return scoped(function* () {
    const pending = yield* link.pendingAnswer(suspensionId, requestEventId);
    if (!pending.ok) {
      throw pending.error;
    }
    return pending.value;
  });
}

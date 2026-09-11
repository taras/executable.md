/**
 * Where a Workspace effect's publication goes.
 *
 * A durable operation publishes its result into the run's journal. When a
 * Workspace effect is the thing publishing, that append has to land in the
 * exact transaction the effect ran inside, so the Files change and the row
 * describing it commit together or not at all. The ordinary journal would
 * append outside the transaction, which is the one ordering that cannot be
 * taken back.
 *
 * So the route is installed for one transaction's descendant scope, keyed to
 * one exact database, transaction and token. Outside that scope the wrapper
 * falls through to the ordinary journal, and a retained token reaches nothing.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { ensure, type Operation, scoped } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";

interface JournalDestinationApi {
  append(database: WorkflowRunDatabase, event: DurableEvent): Operation<boolean>;
}

const RemoteJournalDestination: Api<JournalDestinationApi> = createApi<JournalDestinationApi>(
  "executablemd.workflow.remote.journal.destination",
  {
    // deno-lint-ignore require-yield
    *append(): Operation<boolean> {
      return false;
    },
  },
);

/**
 * Run `publication` with this exact transaction as the journal's destination.
 *
 * The transaction object is the capability. Only code inside the live
 * transaction body holds one, and the caller has already proved through
 * `activeWorkspaceRoute()` that this is that transaction — so there is nothing
 * further to look up, and no registry to outlive the run.
 *
 * Scoped, so the redirection ends with the operation that needed it rather than
 * outliving the transaction it names. `live` closes with that scope: an append
 * arriving afterwards falls through to the ordinary journal instead of reaching
 * a transaction that has closed.
 */
export function withRemoteJournalRoute<T>(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
  publication: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    let live = true;
    yield* ensure(() => {
      live = false;
    });
    yield* RemoteJournalDestination.around(
      {
        *append([candidate, event], next): Operation<boolean> {
          if (candidate !== database || !live) {
            return yield* next(candidate, event);
          }
          yield* transaction.journal.append(event);
          return true;
        },
      },
      { at: "min" },
    );
    return yield* publication;
  });
}

/**
 * The run's journal, willing to be redirected into an open transaction.
 *
 * Reads always come from the ordinary journal: what a transaction has appended
 * is read back through the transaction itself, and a reader outside it is
 * asking about committed history.
 */
export function routeRemoteRunJournal(
  database: WorkflowRunDatabase,
  ordinary: DurableStream,
): DurableStream {
  return {
    readAll: () => ordinary.readAll(),

    *append(event: DurableEvent): Operation<void> {
      if (!(yield* RemoteJournalDestination.operations.append(database, event))) {
        yield* ordinary.append(event);
      }
    },
  };
}

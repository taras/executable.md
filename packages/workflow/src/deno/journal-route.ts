import { type Api, createApi } from "@effectionx/context-api";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { type Operation, scoped } from "effection";
import type { WorkflowRunDatabase, WorkflowRunTransaction } from "../storage/api.ts";
import { WorkflowTransactionError } from "../storage/errors.ts";
import type { WorkflowRunConnections, WorkflowRunTransactionToken } from "./connections.ts";

interface JournalDestinationApi {
  append(database: WorkflowRunDatabase, event: DurableEvent): Operation<boolean>;
}

const ordinaryJournalDestination: JournalDestinationApi = {
  // deno-lint-ignore require-yield
  *append(_database: WorkflowRunDatabase, _event: DurableEvent): Operation<boolean> {
    return false;
  },
};

const JournalDestination: Api<JournalDestinationApi> = createApi<JournalDestinationApi>(
  "executablemd.workflow.deno.journal.destination",
  ordinaryJournalDestination,
);

interface JournalRouteApi {
  bind<T>(
    database: WorkflowRunDatabase,
    transaction: WorkflowRunTransaction,
    token: WorkflowRunTransactionToken,
    publication: Operation<T>,
  ): Operation<T>;
}

function unavailable(): never {
  throw new WorkflowTransactionError(
    "the journal route is not owned by the active Deno workflow storage provider.",
  );
}

const JournalRoute: Api<JournalRouteApi> = createApi<JournalRouteApi>(
  "executablemd.workflow.deno.journal.route",
  {
    // deno-lint-ignore require-yield
    *bind<T>(
      _database: WorkflowRunDatabase,
      _transaction: WorkflowRunTransaction,
      _token: WorkflowRunTransactionToken,
      _publication: Operation<T>,
    ): Operation<T> {
      return unavailable();
    },
  },
);

function validateRoute(
  connections: WorkflowRunConnections,
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
  token: WorkflowRunTransactionToken,
): void {
  const authorized = connections.authorizeTransaction(database, transaction);
  const tokenTransaction = connections.validateToken(database, token);
  if (authorized !== tokenTransaction) {
    throw new WorkflowTransactionError(
      "the journal destination token does not name this exact active transaction.",
    );
  }
}

export function* useJournalRouting(connections: WorkflowRunConnections): Operation<void> {
  yield* JournalDestination.around(
    {
      // deno-lint-ignore require-yield
      *append(): Operation<boolean> {
        return false;
      },
    },
    { at: "min" },
  );
  yield* JournalRoute.around(
    {
      *bind<T>([database, transaction, token, publication]: [
        WorkflowRunDatabase,
        WorkflowRunTransaction,
        WorkflowRunTransactionToken,
        Operation<T>,
      ]): Operation<T> {
        validateRoute(connections, database, transaction, token);
        return yield* scoped(function* () {
          yield* JournalDestination.around(
            {
              *append([candidate, event], next): Operation<boolean> {
                if (candidate !== database) {
                  return yield* next(candidate, event);
                }
                validateRoute(connections, database, transaction, token);
                yield* transaction.journal.append(event);
                yield* connections.afterRoutedJournalAppend(database, event);
                return true;
              },
            },
            { at: "min" },
          );
          return yield* publication;
        });
      },
    },
    { at: "min" },
  );
}

export function routeWorkflowRunJournal(
  database: WorkflowRunDatabase,
  ordinary: DurableStream,
): DurableStream {
  return {
    readAll: () => ordinary.readAll(),

    *append(event: DurableEvent): Operation<void> {
      if (!(yield* JournalDestination.operations.append(database, event))) {
        yield* ordinary.append(event);
      }
    },
  };
}

export function withEnlistedJournalRoute<T>(
  database: WorkflowRunDatabase,
  transaction: WorkflowRunTransaction,
  token: WorkflowRunTransactionToken,
  publication: Operation<T>,
): Operation<T> {
  return JournalRoute.operations.bind(database, transaction, token, publication);
}

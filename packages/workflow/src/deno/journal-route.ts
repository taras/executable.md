import { createContext, type Operation } from "effection";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { WorkflowTransactionError } from "../storage/errors.ts";
import type { RunConnection } from "./connections.ts";

export interface TransactionIdentity {
  readonly id: string;
  readonly connection: RunConnection;
  open: boolean;
}

export interface JournalDestination {
  readonly path: string;
  readonly generation: string;
  readonly transaction: TransactionIdentity;
  readonly journal: DurableStream;
  readonly workspaceRootId: string;
  used: boolean;
}

const Destination = createContext<JournalDestination | undefined>(
  "executablemd.workflow.deno.journal-destination",
  undefined,
);

export function* useJournalDestination(destination: JournalDestination): Operation<void> {
  yield* Destination.set(destination);
}

export function* routeJournalAppend(
  connection: RunConnection,
  standalone: (event: DurableEvent) => Operation<void>,
  event: DurableEvent,
): Operation<void> {
  const destination = yield* Destination.get();
  if (destination === undefined) {
    return yield* standalone(event);
  }
  validateDestination(connection, destination);
  destination.used = true;
  yield* destination.journal.append(event);
}

function validateDestination(connection: RunConnection, destination: JournalDestination): void {
  if (destination.used) {
    refuse("this journal destination has already published its one effect result");
  }
  if (destination.path !== connection.path || destination.transaction.connection !== connection) {
    refuse("this journal destination belongs to a different workflow run database");
  }
  if (destination.generation !== connection.generation) {
    refuse("this journal destination belongs to a stale database connection generation");
  }
  if (!destination.transaction.open || !connection.transactionOpen) {
    refuse("this journal destination's transaction has already completed");
  }
  if (connection.activeTransactionId !== destination.transaction.id) {
    refuse("this journal destination does not name the active transaction identity");
  }
  if (destination.workspaceRootId === "") {
    refuse("this journal destination names no Workspace root");
  }
}

function refuse(reason: string): never {
  throw new WorkflowTransactionError(`${reason}. The event is not appended.`);
}

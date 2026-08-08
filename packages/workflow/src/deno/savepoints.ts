import type { DatabaseSync } from "node:sqlite";
import { createContext, ensure, type Operation, scoped } from "effection";
import { WorkflowTransactionError } from "../storage/errors.ts";

export interface SavepointTransaction {
  readonly open: boolean;
}

export interface SavepointTransactionController {
  validate(transaction: SavepointTransaction): void;
  poison(transaction: SavepointTransaction, failure: unknown): void;
}

export interface SavepointManager {
  synchronous<T>(transaction: SavepointTransaction, body: () => T): T;
  operation<T>(transaction: SavepointTransaction, body: Operation<T>): Operation<T>;
}

export interface SavepointObservationEvent {
  readonly kind: "create" | "release" | "rollback";
  readonly name: string;
}

export type SavepointObserver = (event: SavepointObservationEvent) => void;

export const SavepointObservation = createContext<SavepointObserver>(
  "executablemd.workflow.deno.savepoint.observation",
  () => {},
);

interface OpenSavepoint {
  readonly name: string;
  open: boolean;
}

export function createSavepointManager(
  database: DatabaseSync,
  transactions: SavepointTransactionController,
  observe: SavepointObserver = () => {},
): SavepointManager {
  let next = 0;

  function report(kind: SavepointObservationEvent["kind"], name: string): void {
    try {
      observe(Object.freeze({ kind, name }));
    } catch {
      // Observation cannot change the storage decision it reports.
    }
  }

  function open(transaction: SavepointTransaction): OpenSavepoint {
    transactions.validate(transaction);
    const savepoint = { name: `xmd_savepoint_${next}`, open: true };
    next += 1;
    try {
      database.exec(`SAVEPOINT ${savepoint.name}`);
      report("create", savepoint.name);
      return savepoint;
    } catch (error) {
      savepoint.open = false;
      transactions.poison(transaction, error);
      throw error;
    }
  }

  function release(transaction: SavepointTransaction, savepoint: OpenSavepoint): void {
    transactions.validate(transaction);
    if (!savepoint.open) {
      throw new WorkflowTransactionError("this savepoint has already finished.");
    }
    savepoint.open = false;
    try {
      database.exec(`RELEASE ${savepoint.name}`);
      report("release", savepoint.name);
    } catch (error) {
      transactions.poison(transaction, error);
      throw error;
    }
  }

  function rollback(transaction: SavepointTransaction, savepoint: OpenSavepoint): void {
    if (!savepoint.open) {
      return;
    }
    transactions.validate(transaction);
    savepoint.open = false;
    let failure: unknown;
    try {
      database.exec(`ROLLBACK TO ${savepoint.name}`);
    } catch (error) {
      failure = error;
    }
    try {
      database.exec(`RELEASE ${savepoint.name}`);
    } catch (error) {
      if (failure === undefined) {
        failure = error;
      }
    }
    if (failure !== undefined) {
      transactions.poison(transaction, failure);
      throw failure;
    }
    report("rollback", savepoint.name);
  }

  return {
    synchronous<T>(transaction: SavepointTransaction, body: () => T): T {
      const savepoint = open(transaction);
      try {
        const value = body();
        release(transaction, savepoint);
        return value;
      } catch (error) {
        rollback(transaction, savepoint);
        throw error;
      }
    },

    *operation<T>(transaction: SavepointTransaction, body: Operation<T>): Operation<T> {
      return yield* scoped(function* () {
        const savepoint = open(transaction);
        yield* ensure(() => {
          rollback(transaction, savepoint);
        });

        try {
          const value = yield* scoped(function* () {
            return yield* body;
          });
          release(transaction, savepoint);
          return value;
        } catch (error) {
          rollback(transaction, savepoint);
          throw error;
        }
      });
    },
  };
}

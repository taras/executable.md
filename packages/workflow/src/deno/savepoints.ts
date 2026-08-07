import { ensure, type Operation, scoped } from "effection";
import type { DatabaseSync } from "node:sqlite";
import { WorkflowTransactionError } from "../storage/errors.ts";

export interface SavepointManager {
  synchronous<T>(body: () => T): T;
  operation<T>(body: () => Operation<T>): Operation<T>;
}

export function createSavepointManager(
  database: DatabaseSync,
  isTransactionOpen: () => boolean,
): SavepointManager {
  let next = 0;

  function allocate(): string {
    const name = `xmd_savepoint_${next}`;
    next += 1;
    return name;
  }

  function assertOpen(): void {
    if (!isTransactionOpen()) {
      throw new WorkflowTransactionError(
        "a savepoint needs the caller-owned workflow transaction to remain open.",
      );
    }
  }

  function rollback(name: string): void {
    database.exec(`ROLLBACK TO ${name}`);
    database.exec(`RELEASE ${name}`);
  }

  return {
    synchronous<T>(body: () => T): T {
      assertOpen();
      const name = allocate();
      database.exec(`SAVEPOINT ${name}`);
      try {
        const value = body();
        database.exec(`RELEASE ${name}`);
        return value;
      } catch (error) {
        rollback(name);
        throw error;
      }
    },

    *operation<T>(body: () => Operation<T>): Operation<T> {
      assertOpen();
      const name = allocate();
      database.exec(`SAVEPOINT ${name}`);
      let finished = false;

      yield* ensure(() => {
        if (!finished) {
          rollback(name);
          finished = true;
        }
      });

      let value: T;
      try {
        value = yield* scoped(body);
      } catch (error) {
        rollback(name);
        finished = true;
        throw error;
      }

      database.exec(`RELEASE ${name}`);
      finished = true;
      return value;
    },
  };
}

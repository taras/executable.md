import type { DatabaseSync } from "node:sqlite";
import { WorkflowTransactionError } from "../storage/errors.ts";

export interface SavepointManager {
  synchronous<T>(body: () => T): T;
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
  };
}

/**
 * What "a transaction is open here" means, in two pieces.
 *
 * Shared state has two forms, and this needed both. Which database the current
 * scope is inside a transaction on is composition data: a plain structural
 * value under a stable, namespaced name, which any code may read and which can
 * only ever cause an operation to be refused. Taking a savepoint inside that
 * transaction is an operation, so it lives behind a contextual Api instead of
 * being an executable member of a context value.
 *
 * The savepoint is the seam a Workspace filesystem needs: nested work rolls
 * back its own mutations while staying inside the one transaction that
 * publishes the effect and its journal result together. It is adapter-private —
 * neither piece is exported from the package root — and it hands out no
 * database, so nothing above this boundary can reach SQLite through it.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { type Context, createContext, type Operation } from "effection";
import type { DatabaseSync } from "node:sqlite";
import { WorkflowTransactionError } from "../storage/errors.ts";

/**
 * The database the current scope holds a transaction on, if any.
 *
 * Structural and inert: a path and a flag. Matching on the file rather than on
 * a handle is what makes it useful, because two handles on one run share its
 * turns — an operation reached through the second from inside the first one's
 * body would otherwise wait for a transaction its own caller is holding open.
 *
 * The value can only refuse an operation, never authorize one, which is why
 * comparing a name-addressed binding is safe here.
 */
export interface OpenTransaction {
  readonly path: string;
  readonly open: boolean;
}

export const ActiveTransaction: Context<OpenTransaction | undefined> = createContext<
  OpenTransaction | undefined
>("executablemd.workflow.deno.transaction", undefined);

/** Whether this scope is inside a transaction on `path`. */
export function* holdsTransactionOn(path: string): Operation<boolean> {
  const active = yield* ActiveTransaction.get();
  return active !== undefined && active.path === path;
}

export interface TransactionApi {
  /**
   * Run `body` inside a savepoint, discarding its work if it fails.
   *
   * Answers with what the body answered. A failure rolls the savepoint back
   * and propagates, leaving the surrounding transaction open and free to
   * continue or to fail on its own terms.
   */
  savepoint<T>(body: () => T): Operation<T>;
}

/** No transaction is open in this scope, so there is nothing to nest inside. */
export class NoOpenTransactionError extends WorkflowTransactionError {
  override name = "NoOpenTransactionError";

  constructor() {
    super(
      "a savepoint needs a transaction to be inside, and this scope is not inside one. " +
        "Take savepoints within the body a transaction hands you.",
    );
  }
}

export const Transaction: Api<TransactionApi> = createApi<TransactionApi>(
  "executablemd.workflow.deno.savepoint",
  {
    // deno-lint-ignore require-yield
    *savepoint<T>(_body: () => T): Operation<T> {
      throw new NoOpenTransactionError();
    },
  },
);

/** The savepoint operation, for whoever is inside a transaction. */
export const savepoint: TransactionApi["savepoint"] = Transaction.operations.savepoint;

/** What the open transaction installs so `savepoint()` can answer. */
export function useTransactionSavepoints(
  database: DatabaseSync,
  isOpen: () => boolean,
): Operation<void> {
  let depth = 0;

  return Transaction.around(
    {
      // deno-lint-ignore require-yield
      *savepoint<T>([body]: [() => T]): Operation<T> {
        if (!isOpen()) {
          throw new WorkflowTransactionError(
            "this transaction has already finished, so nothing more can happen inside it.",
          );
        }

        const name = `xmd_savepoint_${depth}`;
        depth += 1;
        database.exec(`SAVEPOINT ${name}`);
        try {
          const value = body();
          database.exec(`RELEASE ${name}`);
          return value;
        } catch (error) {
          database.exec(`ROLLBACK TO ${name}`);
          database.exec(`RELEASE ${name}`);
          throw error;
        } finally {
          depth -= 1;
        }
      },
    },
    { at: "min" },
  );
}

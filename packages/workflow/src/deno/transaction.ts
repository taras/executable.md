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
import { WorkflowTransactionError } from "../storage/errors.ts";
import type { SavepointManager } from "./savepoints.ts";

/**
 * Every database the current scope holds a transaction on.
 *
 * Structural and inert: a path, and whatever was already held when it opened.
 * A chain rather than one path, because transactions on *different* runs may
 * nest — a workflow that reaches two runs opens a transaction on each — and
 * recording only the innermost would hide the outer one. An operation on the
 * outer run would then fail to recognize a transaction its own ancestor is
 * holding, and wait on a lock nobody is going to release.
 *
 * Matching on the file rather than on a handle is what makes it useful, since
 * two handles on one run share its turns.
 *
 * The value can only refuse an operation, never authorize one, which is why
 * comparing a name-addressed binding is safe here.
 */
export interface OpenTransaction {
  readonly path: string;
  readonly enclosing: OpenTransaction | undefined;
}

export const ActiveTransaction: Context<OpenTransaction | undefined> = createContext<
  OpenTransaction | undefined
>("executablemd.workflow.deno.transaction", undefined);

/** The chain this scope would be inside after opening a transaction on `path`. */
export function* enclosing(path: string): Operation<OpenTransaction> {
  return { path, enclosing: yield* ActiveTransaction.get() };
}

/** Whether this scope, or anything enclosing it, holds a transaction on `path`. */
export function* holdsTransactionOn(path: string): Operation<boolean> {
  let active = yield* ActiveTransaction.get();
  while (active !== undefined) {
    if (active.path === path) {
      return true;
    }
    active = active.enclosing;
  }
  return false;
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
  savepoints: SavepointManager,
  isOpen: () => boolean,
): Operation<void> {
  return Transaction.around(
    {
      // deno-lint-ignore require-yield
      *savepoint<T>([body]: [() => T]): Operation<T> {
        if (!isOpen()) {
          throw new WorkflowTransactionError(
            "this transaction has already finished, so nothing more can happen inside it.",
          );
        }

        return savepoints.synchronous(body);
      },
    },
    { at: "min" },
  );
}

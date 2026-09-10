/**
 * A savepoint inside one Workspace mutation, whichever host is performing it.
 *
 * One mutation may change several things and then find that it cannot finish
 * one of them. What the shared Files and composition rules do about that is
 * ask for the failed part to be undone and carry on — a write that created two
 * parent directories and was then refused leaves neither behind, and the
 * refusal is journaled against the Workspace as it was.
 *
 * How that is undone is the host's. The local host takes a real SQLite
 * savepoint inside the transaction it is already in; the runner works in a
 * disposable attempt and restores it from the accepted root. Both answer the
 * same question, so the rules above them do not know which one they are
 * running on — and a scope with no host answering at all refuses rather than
 * performing work nothing can take back.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { WorkflowTransactionError } from "../storage/errors.ts";

export interface TransactionApi {
  /**
   * Run `body` inside a savepoint, discarding its work if it fails.
   *
   * Answers with what the body answered. A failure rolls the savepoint back
   * and propagates, leaving the surrounding transaction open and free to
   * continue or to fail on its own terms.
   */
  savepoint<T>(body: Operation<T>): Operation<T>;
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
    *savepoint<T>(_body: Operation<T>): Operation<T> {
      throw new NoOpenTransactionError();
    },
  },
);

/** The savepoint operation, for whoever is inside a transaction. */
export const savepoint: TransactionApi["savepoint"] = Transaction.operations.savepoint;

/**
 * An XMD-owned execution Api — the boundary a pause would mediate.
 *
 * #841 asks whether middleware around an execution Api can withhold a running
 * subtree's continuations. That question only means something if the Api is the
 * one XMD would actually own, so this is modelled on what an engine does rather
 * than on what is convenient to gate: it advances an execution by one journaled
 * step, it forks a child execution, and it performs one external operation whose
 * work happens outside Effection.
 *
 * Nothing here knows about pausing. A gate is installed by decorating this Api
 * on one scope, and the fixtures below run identically with no gate at all —
 * which is what makes "the middleware is what stopped it" a claim the evidence
 * can separate from "the fixture cooperated".
 */

import { createContext, until, useScope } from "effection";
import type { Operation, Task } from "effection";
import { createApi } from "effection/experimental";

import type { Journal } from "./journal.ts";

/** The session journal every execution appends to. */
export const ExecutionJournal = createContext<Journal>("xmd.execution.journal");

/** Which execution the current scope's records belong to. */
export const ExecutionOwner = createContext<string>("xmd.execution.owner");

export interface ExecutionApi {
  /**
   * Advance this execution by one journaled step.
   *
   * @returns the journal's length after the record was appended
   */
  step(label: string): Operation<number>;
  /**
   * Run `body` as a child execution owned by the calling execution.
   */
  fork(label: string, body: () => Operation<void>): Operation<Task<void>>;
  /**
   * Perform one operation whose work happens outside Effection, then journal
   * its result. The promise is already in flight when this is invoked, so the
   * external system is never frozen by anything that happens here.
   */
  external(label: string, work: Promise<string>): Operation<string>;
}

export const Execution = createApi<ExecutionApi>("xmd.execution", {
  *step(label) {
    const journal = yield* ExecutionJournal.expect();
    const owner = yield* ExecutionOwner.expect();
    return journal.append(owner, label);
  },
  *fork(label, body) {
    const scope = yield* useScope();
    return yield* scope.spawn(function* () {
      yield* ExecutionOwner.set(label);
      yield* body();
    });
  },
  *external(label, work) {
    const value = yield* until(work);
    const journal = yield* ExecutionJournal.expect();
    const owner = yield* ExecutionOwner.expect();
    journal.append(owner, `${label}=${value}`);
    return value;
  },
});

export const { step, fork, external } = Execution.operations;

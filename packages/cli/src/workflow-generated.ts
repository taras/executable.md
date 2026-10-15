/**
 * What a workflow command offers one execution, and how it offers it.
 *
 * A workflow run's generated selection is the Workflow host's own: it is
 * offered inside the Workspace attachment, in the scope that executes the
 * document. The two helpers here are what every execution a workflow command
 * builds goes through, so that *whether* an execution is offered a selection is
 * stated at each site rather than inherited from whatever encloses it.
 *
 * It matters because `xmd` installs the ordinary `xmd run` selection in the
 * scope that encloses every command, as the ordinary contextual default. A
 * default answers where nothing nearer does — which is correct for a document
 * an ordinary run executes, and wrong for a workflow execution this host
 * offered nothing: a compatibility replay or a completed replay would then be
 * executed under a vocabulary the workflow host never stated.
 *
 * Shared by `workflow.ts` and `workflow-fork.ts` rather than exported from
 * either: the command imports the fork preflight, so the preflight cannot
 * import the command back.
 */

import { Component } from "@executablemd/core/api";
import type { Operation } from "effection";

/**
 * Install one host setup operation, then run the document in that same scope.
 *
 * Ordinary mechanics rather than a capture protocol: what a selection answers
 * has to be composed in a scope that is still open when canonical execution
 * reads it, and the attachment chain is built from operations rather than from
 * scopes a caller can reach into.
 */
export function* offering<T>(operation: Operation<T>, setup: () => Operation<void>): Operation<T> {
  yield* setup();
  return yield* operation;
}

/**
 * State that this execution offers no generated evaluation at all.
 *
 * `undefined` is the answer core itself starts from, so an execution that
 * states it is an execution with no generated evaluation — which `<Evaluate>`
 * reports where it is written rather than at startup. Stated rather than left
 * absent, because absence is what an enclosing default answers.
 */
export function useNoGeneratedEvaluation(): Operation<void> {
  return Component.around({ generated: () => undefined });
}

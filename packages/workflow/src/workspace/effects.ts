/**
 * How a document's Workspace work becomes one durable effect, whichever host
 * holds the run.
 *
 * There is one set of rules for what `<File>`, `<Repository>`, `<Worktree>`,
 * `<Dir>` and the Git components mean, and there are two places a run's storage
 * can live. Writing the rules twice is how the two would start to differ, so
 * the rules stay where they are and this is the one thing they ask a host for:
 * turn this mutation into the effect that performs it.
 *
 * The host answers with an effect bound to what it already proved. The local
 * host closes over the lease it validated; the runner closes over the exact
 * remote run its own acquisition opened. Neither authority is in this contract
 * and neither can be supplied by a caller.
 *
 * Which binding answers is decided by the exact handle, not by anything a scope
 * can reach. An attachment registers its binding under the handle it was given
 * — the one its own lifecycle produced — and unregisters it when the attachment
 * ends. So a document holding a second run's handle finds that run's binding or
 * none, a handle nobody attached finds none, and a replaceable context value is
 * never what says a database, journal or publication target belongs to a run.
 */

import { ensure, type Operation } from "effection";
import type { DurableEffect, EffectDescription, Json } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowTransactionError } from "../storage/errors.ts";
import type { WorkspaceFilesystem } from "./filesystem.ts";
import type { WorkspaceMetadata } from "./metadata.ts";

/**
 * What a Workspace mutation is given.
 *
 * The authoritative filesystem first, because most mutations are only about
 * bytes. Retained Repository and Worktree identity follows it, in the same
 * transaction, so a mutation that needs both commits both or neither.
 */
export type WorkspaceMutation<T extends Json> = (
  filesystem: WorkspaceFilesystem,
  metadata: WorkspaceMetadata,
) => Operation<T>;

/** What a host contributes: one effect for one mutation of one run. */
export interface WorkspaceEffectBinding {
  /**
   * The effect that performs this mutation.
   *
   * Synchronous, because an effect is a value a document yields rather than
   * work of its own: building one is not a place a scope may suspend, and a
   * `Workflow` body yields effects and nothing else.
   */
  create<T extends Json>(
    description: EffectDescription,
    mutate: WorkspaceMutation<T>,
  ): DurableEffect<T>;
}

const bindings = (() => {
  const held = new WeakMap<WorkflowRunDatabase, WorkspaceEffectBinding>();
  return {
    attach(database: WorkflowRunDatabase, binding: WorkspaceEffectBinding): void {
      held.set(database, binding);
    },
    detach(database: WorkflowRunDatabase): void {
      held.delete(database);
    },
    of(database: WorkflowRunDatabase): WorkspaceEffectBinding | undefined {
      return held.get(database);
    },
  };
})();

/**
 * Bind this run's Workspace effects for as long as the attachment lasts.
 *
 * Registered for the exact handle the host attached and removed when that scope
 * ends, however it ends — so an effect created after the attachment is over
 * finds nothing rather than a stale filesystem or a closed transaction.
 */
export function* useWorkspaceEffects(
  database: WorkflowRunDatabase,
  binding: WorkspaceEffectBinding,
): Operation<void> {
  bindings.attach(database, binding);
  yield* ensure(() => {
    bindings.detach(database);
  });
}

/**
 * The binding this run is attached through.
 *
 * Refuses rather than answering with nothing: a document that reached a
 * Workspace operation with no attachment is asking for a mutation no host has
 * agreed to perform, and performing it against whatever filesystem happens to
 * be in scope is the one outcome that must not be possible.
 */
export function workspaceEffectsFor(database: WorkflowRunDatabase): WorkspaceEffectBinding {
  const binding = bindings.of(database);
  if (binding === undefined) {
    throw new WorkflowTransactionError(
      "this workflow run has no Workspace attachment, so a Workspace effect cannot be " +
        "created. A host attaches one for a live or partial document execution.",
    );
  }
  return binding;
}

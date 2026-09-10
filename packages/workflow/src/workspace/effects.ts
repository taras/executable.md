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

import { ensure, type Operation, type Result } from "effection";
import type { DurableEffect, EffectDescription, Json } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowTransactionError } from "../storage/errors.ts";
import type { WorkspaceFilesystem } from "./filesystem.ts";
import type { WorkspaceMetadata } from "./metadata.ts";
import type { AgentSessions } from "../storage/agent-session.ts";

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

/**
 * What an ephemeral attachment is allowed to see.
 *
 * A checkout is rebuilt from the Workspace and proved to be the retained one on
 * every partial execution, and doing that needs two things: the bytes, and the
 * record that names them. It needs nothing else — no publication, no capture,
 * no restore, no root selection — so this is the whole of what it is handed,
 * and a host cannot hand it more by supplying a wider object.
 */
export interface WorkspaceAttachmentView {
  readonly filesystem: WorkspaceFilesystem;
  readonly metadata: WorkspaceMetadata;
}

/**
 * What a host contributes for one run, and the whole of it.
 *
 * Three things, because a document reaches exactly three kinds of Workspace
 * work: the effect a mutation becomes, the read an ephemeral attachment needs,
 * and the transaction an Agent-session mapping is retained by. Everything else
 * the rules do is arithmetic above these.
 */
export interface WorkspaceHostBinding {
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
  /**
   * Read this run's retained Workspace for one ephemeral attachment.
   *
   * Nothing durable happens here: a checkout is exported to a host directory
   * and proved, and the Workspace is left exactly as it was found. The scope
   * this opens closes before native work runs against what it exported, so no
   * transaction and no owner read is held across a Git process.
   */
  read<T>(body: (view: WorkspaceAttachmentView) => Operation<T>): Operation<Result<T>>;
  /**
   * Read and commit this run's Agent-session mappings, in one transaction.
   *
   * The narrow half of the run's retained state, and the only half a host
   * installing an Agent profile needs. A conversation and the row naming it are
   * one fact, so the mapping this returns is retained by the run's own owner or
   * by nothing — and the provider that establishes the conversation is never
   * called from inside that transaction.
   */
  sessions<T>(body: (sessions: AgentSessions) => Operation<T>): Operation<Result<T>>;
}

const bindings = (() => {
  const held = new WeakMap<WorkflowRunDatabase, WorkspaceHostBinding>();
  return {
    attach(database: WorkflowRunDatabase, binding: WorkspaceHostBinding): void {
      held.set(database, binding);
    },
    detach(database: WorkflowRunDatabase): void {
      held.delete(database);
    },
    of(database: WorkflowRunDatabase): WorkspaceHostBinding | undefined {
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
export function* useWorkspaceHost(
  database: WorkflowRunDatabase,
  binding: WorkspaceHostBinding,
): Operation<void> {
  // What was bound before, restored when this scope ends. A handle's own host
  // binds one when it opens the handle at all — reading a mapping needs no
  // attachment — and an attachment binds a narrower one for as long as the
  // document runs. Detaching to nothing would leave the handle unusable for
  // the rest of its own life.
  const outer = bindings.of(database);
  bindings.attach(database, binding);
  yield* ensure(() => {
    if (outer === undefined) {
      bindings.detach(database);
      return;
    }
    bindings.attach(database, outer);
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
export function workspaceHostFor(database: WorkflowRunDatabase): WorkspaceHostBinding {
  const binding = bindings.of(database);
  if (binding === undefined) {
    throw new WorkflowTransactionError(
      "this workflow run has no Workspace attachment, so a Workspace effect cannot be " +
        "created. A host attaches one for a live or partial document execution.",
    );
  }
  return binding;
}

/**
 * Read and commit this run's Agent-session mappings, wherever it lives.
 *
 * The same name and the same narrow behavior a host installing an Agent profile
 * has always used, answered by whichever host attached this exact handle. A
 * conversation and the row naming it are one fact, so what the body stages is
 * retained by the run's own owner or by nothing — and no provider call happens
 * inside that transaction.
 */
export function transactAgentSessions<T>(
  database: WorkflowRunDatabase,
  body: (sessions: AgentSessions) => Operation<T>,
): Operation<Result<T>> {
  return workspaceHostFor(database).sessions(body);
}

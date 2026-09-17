/**
 * Holding a capability to the callback it was handed to.
 *
 * A Workspace transaction stays open after the mutation inside it returns — it
 * goes on to capture a root, publish it and enlist the journal — and an
 * inspection's transaction is open for the same reason. So a filesystem, a
 * storage view or a savepoint that a callback kept is not merely a stale
 * object: it is a live capability inside a transaction that is still running,
 * and using it would write work no effect publishes and no journal records.
 *
 * Revocation is what makes "for this callback" a fact. One gate serves every
 * projection built from one callback's argument, so the transaction ends all of
 * them together rather than each object having a lifetime of its own.
 *
 * ## Why an operation is checked twice
 *
 * Most of these members do not do the work; they return an `Operation` that
 * does it when something yields it. Checking only when the member is *called*
 * would leave the obvious hole open: a callback creates the operations it wants
 * while it is still valid, returns, and yields them afterwards. So a gated
 * member checks when it is called — which fails fast, and is what a caller
 * holding a revoked object sees — and the operation it returns checks again
 * when its body begins.
 */

import type { Operation } from "effection";
import { WorkflowTransactionError } from "../../storage/errors.ts";
import type {
  DenoWorkspaceEntry,
  DenoWorkspaceFilesystem,
  DenoWorkspaceStat,
} from "./filesystem.ts";

/** The gate a revocable capability closes over. */
export interface Revocation {
  held(): void;
  revoke(): void;
}

export function revocation(): Revocation {
  let open = true;
  return {
    held(): void {
      if (!open) {
        throw new WorkflowTransactionError(
          "the Workspace view is no longer the one this callback was given. It is valid only " +
            "while the callback that received it is running.",
        );
      }
    },
    revoke(): void {
      open = false;
    },
  };
}

function* gate<T>(held: () => void, make: () => Operation<T>): Operation<T> {
  held();
  return yield* make();
}

/** An operation this gate admits when it is created and again when it runs. */
export function gatedOperation<T>(held: () => void, make: () => Operation<T>): Operation<T> {
  held();
  return gate(held, make);
}

/**
 * The read half of a Workspace filesystem.
 *
 * Its own type rather than the whole filesystem with a promise not to write: an
 * inspection that could write would be a mutation whose work no effect
 * publishes and no journal records.
 */
export interface WorkflowWorkspaceReads {
  readFile(path: string): Operation<Uint8Array>;
  readTextFile(path: string): Operation<string>;
  stat(path: string): Operation<DenoWorkspaceStat>;
  lstat(path: string): Operation<DenoWorkspaceStat>;
  readlink(path: string): Operation<string>;
  readdir(path: string): Operation<DenoWorkspaceEntry[]>;
}

/** The reading members alone, each held to the callback that received them. */
export function guardedWorkflowWorkspaceReads(
  filesystem: WorkflowWorkspaceReads,
  held: () => void,
): WorkflowWorkspaceReads {
  return {
    readFile: (path) => gatedOperation(held, () => filesystem.readFile(path)),
    readTextFile: (path) => gatedOperation(held, () => filesystem.readTextFile(path)),
    stat: (path) => gatedOperation(held, () => filesystem.stat(path)),
    lstat: (path) => gatedOperation(held, () => filesystem.lstat(path)),
    readlink: (path) => gatedOperation(held, () => filesystem.readlink(path)),
    readdir: (path) => gatedOperation(held, () => filesystem.readdir(path)),
  };
}

/**
 * The whole filesystem, held to the mutation that received it.
 *
 * Every member, not only the writing ones. A read performed after the mutation
 * returned would be reading a Workspace mid-publication, and answering it would
 * make the boundary's own ordering observable.
 */
export function guardedWorkflowWorkspaceFilesystem(
  filesystem: DenoWorkspaceFilesystem,
  held: () => void,
): DenoWorkspaceFilesystem {
  return {
    ...guardedWorkflowWorkspaceReads(filesystem, held),
    writeFile: (path, content, mode) =>
      gatedOperation(held, () => filesystem.writeFile(path, content, mode)),
    mkdir: (path, options) => gatedOperation(held, () => filesystem.mkdir(path, options)),
    remove: (path, options) => gatedOperation(held, () => filesystem.remove(path, options)),
    rename: (from, to) => gatedOperation(held, () => filesystem.rename(from, to)),
    chmod: (path, mode) => gatedOperation(held, () => filesystem.chmod(path, mode)),
    symlink: (target, path) => gatedOperation(held, () => filesystem.symlink(target, path)),
    link: (existingPath, newPath) =>
      gatedOperation(held, () => filesystem.link(existingPath, newPath)),
  };
}

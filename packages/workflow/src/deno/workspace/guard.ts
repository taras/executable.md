/**
 * Revoke callback-owned Workspace capabilities before later publication work.
 * The transaction remains open after a mutation or inspection callback returns;
 * retained filesystem, storage and savepoint views must not reach that live window.
 * One gate revokes every projection of the callback's argument together.
 *
 * Operation-returning members check both when called and when yielded, preventing
 * a callback from constructing work while authorized and running it after return.
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

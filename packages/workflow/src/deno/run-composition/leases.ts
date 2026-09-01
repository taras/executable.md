/**
 * The locks an ordinary run holds on the slots it is working in.
 *
 * A workflow run owns its Workspace outright, so nothing coordinates with
 * anything. A managed host root is shared: two `xmd run` processes on one
 * machine may name the same Repository at the same moment, and one of them
 * cloning into the directory the other is committing in would corrupt both.
 *
 * So a slot is entered under an exclusive kernel-backed advisory lock, taken
 * without waiting. Refusing rather than waiting is what makes the answer
 * useful: "somebody else is working in this checkout" is something the person
 * running the document can act on, and a hang is not. The kernel is also what
 * makes it survive a lost host — a killed process runs no cleanup and the
 * operating system releases its locks anyway, which is the only evidence this
 * accepts that a previous holder is gone.
 *
 * ## The hold is execution-wide, deliberately
 *
 * The lease is acquired into the scope the provider was installed in rather
 * than into the component invocation that asked for it, so it outlives the
 * element. A self-closing `<Worktree as="worktree" />` binds a path that a
 * later sibling `<Dir path={worktree}>` and an interactive `<Session>` inside it
 * go on using; a lease that ended with the Worktree element would leave both
 * working in a slot another process could take.
 *
 * Selecting the same slot twice in one execution reuses the lease already held.
 * It is the same process and the same provider: taking a second exclusive lock
 * on a file this process already holds is not a coordination question.
 *
 * Nothing here unlinks a lock file. Unlinking a locked path lets the next
 * caller create and lock a different file at the same name while this lock is
 * still held, so the sidecar is created if absent and then left, empty.
 */

import { race, suspend, useScope, withResolvers, type Operation, type Scope } from "effection";
import { useAdvisoryLock } from "../advisory-lock.ts";
import type { AdvisoryLockFile } from "../advisory-lock.ts";
import { ManagedCheckoutError } from "./errors.ts";
import { lockOf } from "./placement.ts";

export type SlotKind = "repository" | "worktree";

export interface Leases {
  /**
   * Hold this slot for the rest of the execution, or refuse.
   *
   * Idempotent per slot: a second call for a slot this execution already holds
   * returns without asking the operating system anything.
   */
  hold(kind: SlotKind, slot: string, subject: string): Operation<void>;
}

export function* useLeases(root: string): Operation<Leases> {
  // The scope the provider is installed in, captured once. Every lease is
  // acquired into it, so all of them are released — by the kernel and by the
  // resource's own teardown — when the document execution ends, on success,
  // failure and cancellation alike.
  const owner: Scope = yield* useScope();
  const held = new Set<string>();

  return {
    *hold(kind: SlotKind, slot: string, subject: string): Operation<void> {
      const path = lockOf(root, kind, slot);
      if (held.has(path)) {
        return;
      }
      // The acquisition runs in the provider's scope and then *suspends*, which
      // is what makes the hold last as long as the provider does. A task that
      // returned the handle would complete, and completing releases everything
      // the task acquired — so the lock would be gone the moment the element
      // that asked for it finished, and a second process could take the slot
      // out from under an interactive Session still working in it.
      const acquired = withResolvers<AdvisoryLockFile | undefined>();
      const failed = withResolvers<never>();
      owner.run(function* () {
        let file: AdvisoryLockFile | undefined;
        try {
          file = yield* useAdvisoryLock(path);
        } catch (error) {
          failed.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        acquired.resolve(file);
        if (file === undefined) {
          // Refused. There is nothing to hold open, so this task ends rather
          // than suspending for the rest of the execution over a lock it never
          // took.
          return;
        }
        yield* suspend();
      });
      const file = yield* race([acquired.operation, failed.operation]);
      if (file === undefined) {
        throw new ManagedCheckoutError(
          "in-use",
          `another process is working in the managed checkout for ${subject}. Nothing was read ` +
            "and nothing was changed; the other process releases it when it ends.",
        );
      }
      held.add(path);
    },
  };
}

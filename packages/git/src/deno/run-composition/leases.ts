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
import { useAdvisoryLock } from "@executablemd/workflow/deno";
import type { AdvisoryLockFile } from "@executablemd/workflow/deno";
import { ManagedCheckoutError } from "./errors.ts";
import { lockOf } from "./placement.ts";

export type SlotKind = "repository" | "worktree";

/**
 * What one lease is for: a managed placement slot, or a shared Git directory.
 *
 * A `common` lease is the one that makes repository work in a retained entry
 * resumable. The placement leases keep two processes out of one managed
 * checkout; this one keeps them out of one object database and one set of refs,
 * which is what a commit, an index write or adding a worktree actually moves —
 * and which several checkouts can share.
 */
export type LeaseKind = SlotKind | "common";

/** One lease to take, named the way its kind names things. */
export interface LeaseRequest {
  readonly kind: LeaseKind;
  /** A managed slot, or the canonical common Git directory for `common`. */
  readonly slot: string;
  readonly subject: string;
  /**
   * What a refusal of this one lease means to whoever asked for it.
   *
   * An ordinary run has one answer — the composition error below, which the
   * document is shown. A retained entry has a different one for the lane it
   * records its work in: an entry that cannot own that directory cannot make
   * anything it does resumable, so the refusal is not something to render and
   * carry on from. Which of those a lease is held under is the caller's to say,
   * not this coordinator's.
   */
  readonly refuse?: (message: string) => Error;
}

export interface Leases {
  /**
   * Hold this slot for the rest of the execution, or refuse.
   *
   * Idempotent per slot: a second call for a slot this execution already holds
   * returns without asking the operating system anything.
   */
  hold(kind: LeaseKind, slot: string, subject: string): Operation<void>;
  /**
   * Hold all of these, in one order whoever is asking.
   *
   * Sorted by the path each lease locks, so two processes asking for an
   * overlapping pair ask for them in the same sequence. These leases refuse
   * rather than wait, so no ordering of them can deadlock; what a fixed order
   * buys is that the same contention produces the same refusal rather than one
   * that depends on which caller got there first.
   */
  holdAll(requests: readonly LeaseRequest[]): Operation<void>;
}

export function* useLeases(root: string): Operation<Leases> {
  // The scope the provider is installed in, captured once. Every lease is
  // acquired into it, so all of them are released — by the kernel and by the
  // resource's own teardown — when the document execution ends, on success,
  // failure and cancellation alike.
  const owner: Scope = yield* useScope();
  const held = new Set<string>();

  function* take({ kind, slot, subject, refuse }: LeaseRequest): Operation<void> {
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
      const what = kind === "common" ? subject : `the managed checkout for ${subject}`;
      const message =
        `another process is working in ${what}. Nothing was read and nothing was changed; ` +
        "the other process releases it when it ends.";
      throw refuse === undefined ? new ManagedCheckoutError("in-use", message) : refuse(message);
    }
    held.add(path);
  }

  return {
    *hold(kind: LeaseKind, slot: string, subject: string): Operation<void> {
      yield* take({ kind, slot, subject });
    },
    *holdAll(requests: readonly LeaseRequest[]): Operation<void> {
      // Sorted by the path each one locks, so an overlapping pair is always
      // asked for in the same sequence whichever caller is asking.
      const ordered = [...requests].sort((left, right) => {
        const here = lockOf(root, left.kind, left.slot);
        const there = lockOf(root, right.kind, right.slot);
        return here < there ? -1 : here > there ? 1 : 0;
      });
      for (const request of ordered) {
        yield* take(request);
      }
    },
  };
}

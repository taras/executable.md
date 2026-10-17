/**
 * Hold managed checkout slots under non-blocking exclusive kernel advisory locks.
 * A busy slot refuses immediately; process death releases the lock without cleanup.
 *
 * Leases belong to the installed provider's execution scope, outliving the element
 * that selected a slot so later Dir and interactive Session siblings stay protected.
 * Repeated selection reuses the execution's lease.
 *
 * Lock sidecars remain empty on disk. Unlinking a locked path would let another
 * process lock a new file at the same name while the original lock is still held.
 */

import { race, suspend, useScope, withResolvers, type Operation, type Scope } from "effection";
import { useAdvisoryLock } from "@executablemd/workflow/deno";
import type { AdvisoryLockFile } from "@executablemd/workflow/deno";
import { ManagedCheckoutError } from "./errors.ts";
import { lockOf } from "./checkout-layout.ts";

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
  // Capture the provider scope so leases outlive individual elements.
  const owner: Scope = yield* useScope();
  const held = new Set<string>();

  return {
    *hold(kind: SlotKind, slot: string, subject: string): Operation<void> {
      const path = lockOf(root, kind, slot);
      if (held.has(path)) {
        return;
      }
      // Keep the resource task suspended; returning would release the slot immediately.
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

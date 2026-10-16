/**
 * The one checkout a live REPL entry is working in, held or refused.
 *
 * Two entries moving files in one repository is the hazard, and one mechanism
 * answers it: the kernel lock on a sidecar beside the repository. `flock` and
 * `LockFileEx` both exclude *independently opened* handles — including two
 * opened by one process — so a second entry here is refused by the operating
 * system exactly as a second process is, and the native descriptor is the only
 * live resource involved. Nothing else is needed: no table of who holds what,
 * no acquisition token, and no state a caller could substitute.
 *
 * Refusing rather than waiting is what makes the answer useful. An entry that
 * cannot have the repository it needs is told so before it reads a byte of it,
 * and a person with two entries open gets a sentence rather than a stall.
 *
 * The sidecar is left in place. Unlinking a locked path lets the next caller
 * create and lock a different file at the same name while this lock is still
 * held.
 */

import type { Operation } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { useAdvisoryLock } from "@executablemd/workflow/deno";
import { commonDirectoryLock } from "../run-composition/placement.ts";

/**
 * A checkout another live entry or another process is already working in.
 *
 * A `StaleInputError`, and raised before the mutation it would have guarded.
 * Two things follow from that, and both are the point. A document cannot print
 * it away and carry on, because a later sibling running as though the write had
 * happened is exactly what the exclusion exists to prevent. And it never
 * becomes a saved local refusal: a lease is busy only for as long as somebody
 * else is working, so recording "refused" would make a temporary condition the
 * permanent answer every later continuation replays.
 */
export class CommonDirectoryLeaseError extends StaleInputError {
  override name = "CommonDirectoryLeaseError";

  readonly reason = "checkout-in-use";

  constructor() {
    super(
      "Another XMD entry or process holds this checkout. End that work before trying again. " +
        "Nothing was read and nothing was changed.",
    );
  }
}

/**
 * Hold the canonical common Git directory for the calling scope, or refuse.
 *
 * The caller reaches this through the entry owner's lazy single-flight
 * acquisition, so one entry takes one handle however many mutations ask for it,
 * and the handle lasts as long as the entry rather than as long as the element
 * that first needed it. The release is registered before the descriptor is
 * opened, inside the helper this delegates to.
 */
export function* useCommonDirectoryLease(commonDirectory: string): Operation<void> {
  const held = yield* useAdvisoryLock(commonDirectoryLock(commonDirectory));
  if (held === undefined) {
    throw new CommonDirectoryLeaseError();
  }
}

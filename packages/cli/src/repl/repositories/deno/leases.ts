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
import { commonDirectoryLock } from "@executablemd/git/deno";
import { ManagedCheckoutError } from "@executablemd/git/deno";
import type { ManagedCheckoutReason } from "@executablemd/git/deno";

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

/**
 * A managed slot this entry cannot take back, raised where a file needed it.
 *
 * A restored placement acquires its slot at the first new operation inside it,
 * which is a long way from where the selection was recorded — and by then the
 * call is a `<File>` or a `<Dir>`, whose refusals are ordinary Files outcomes
 * the journal keeps. This is not one of those: another entry holding the slot
 * is a condition that lasts as long as their work, and recording it as this
 * operation's answer would make it permanent.
 *
 * So the condition travels as a `StaleInputError` carrying the provider's own
 * sentence. Core cannot turn it into a recorded File outcome, a document cannot
 * print it away, and later siblings do not run as though the file had been
 * written.
 */
export class ManagedPlacementHoldError extends StaleInputError {
  override name = "ManagedPlacementHoldError";

  readonly reason: ManagedCheckoutReason;

  constructor(refusal: ManagedCheckoutError) {
    super(refusal.message);
    this.reason = refusal.reason;
  }
}

/**
 * Take a managed slot back for a restored placement, or raise it as fatal.
 *
 * Only the managed vocabulary's own refusal is translated. Anything else is not
 * a condition this boundary has a word for and travels untouched.
 */
export function* holdManagedPlacement(acquire: () => Operation<void>): Operation<void> {
  try {
    yield* acquire();
  } catch (error) {
    if (error instanceof ManagedCheckoutError) {
      throw new ManagedPlacementHoldError(error);
    }
    throw error;
  }
}

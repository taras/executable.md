/**
 * The managed slot a restored REPL placement takes back, held or refused.
 *
 * A managed slot is the only hold a REPL entry takes on a checkout. The ordinary
 * slot lease answers who owns it; this module translates that lease's refusal
 * where a file or Git operation inside a restored placement needed it.
 */

import type { Operation } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { ManagedCheckoutError } from "@executablemd/git/deno";
import type { ManagedCheckoutReason } from "@executablemd/git/deno";

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

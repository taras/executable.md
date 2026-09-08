/**
 * The credential gate a delivered answer crosses, at the owner.
 *
 * The same gate durable journal persistence is written through — the scanner
 * the local host runs, not a summary of it. It runs here because the settled
 * contract is that the retained row and the event it may become cross that
 * exact gate before either exists, and an authenticated caller reaching this
 * owner directly must not be able to decide which checks happened.
 *
 * It runs outside the transaction because it cannot run inside one: the scanner
 * is asynchronous and a Durable Object transaction has to finish before it can
 * commit. That is sound rather than convenient — the framings it reads are
 * built from the value in the request, which does not change, and from a wait
 * identity the transaction requires to still be the one retained before it
 * writes anything.
 *
 * A scanner that could not run at all is a refusal. What must not happen is a
 * value entering retained state because the gate failed to say no.
 */

import type { Operation } from "effection";
import { createSecretScanner } from "@executablemd/core/secrets";
import type { SecretFinding } from "@executablemd/core/secrets";
import { CommandError } from "./commands.ts";

/**
 * Read every framing, and refuse the value if any of them is a credential.
 *
 * The scanner is created for this delivery and reclaimed with it, so its
 * fingerprints mean nothing outside this call. Nothing about what was matched
 * travels: the refusal is one category, and a diagnostic quoting the value or
 * the match would publish exactly what the gate exists to keep out.
 */
export function* crossSecretGate(framings: readonly string[]): Operation<void> {
  const scanner = createSecretScanner();
  for (const framing of framings) {
    let found: SecretFinding[];
    try {
      found = yield* scanner.scan(framing);
    } catch {
      // A gate that could not read this value has not passed it.
      throw new CommandError("credential-detected");
    }
    if (found.length > 0) {
      throw new CommandError("credential-detected");
    }
  }
}

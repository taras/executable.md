/**
 * The stable name an admitted locator is known by.
 *
 * The grammar a locator is admitted through is provider-neutral and lives in
 * `../../composition/locator.ts`; this is the other half of that module's
 * prose. A fingerprint is the digest of the admitted bytes, and the retained
 * paths that recompute one — holding a stored row to the identity that names
 * it, holding a saved origin to the Repository it belongs to — answer without
 * performing anything at all, so the digest they use has to be synchronous.
 * `node:crypto` has one and Web Crypto does not, which is why this is here,
 * where naming a runtime is what the module is for, rather than beside the
 * grammar, where naming one is what that surface refuses.
 *
 * Admission is re-exported so a caller that needs both asks one module for
 * them: the two questions are about one string and the answer to the second has
 * to be the digest of what the first admitted.
 */

import { createHash } from "node:crypto";

export { admitLocator } from "../../composition/locator.ts";

/** The stable name an admitted locator is known by everywhere but its own column. */
export function locatorFingerprint(locator: string): string {
  return createHash("sha256").update(locator, "utf8").digest("hex");
}

/**
 * What a provider says about the implementation it supplied, and when that
 * claim stops meaning anything.
 *
 * `Component.importComponent` middleware may replace what a name resolves to.
 * For ordinary expansion that is the whole point and needs nothing more. For a
 * generated fragment it is not enough: an admission is a decision about *which
 * implementation* a fragment may run, and a continuation has to be able to tell
 * that the implementation behind a name is still the one it was admitted with.
 * A function has no identity a run can retain — comparing one is comparing how
 * somebody wrote their code — so the identity has to be *stated*.
 *
 * ## Stated on the exact final answer, and nowhere else
 *
 * A provider states `{ origin, key, revision }` against the exact object it is
 * returning, through a claimant this execution minted. The claim is keyed by
 * that object, so:
 *
 * - a handler further out that replaces the answer returns a *different*
 *   object, which carries no claim — an intermediate claim does not survive
 *   being replaced;
 * - a handler that mutates the claimed object fails the retained comparison,
 *   because the claim keeps core's own copy of what was claimed;
 * - nothing travels on the definition, so a claim cannot be read off it, copied
 *   onto another answer, or forged by describing one.
 *
 * The claimant is minted per execution and revoked with it. A provider that
 * kept one cannot state an identity in a later run, and an answer claimed in a
 * run that has ended identifies nothing.
 *
 * ## What this is not
 *
 * It is not authority. Claiming an identity does not admit a component into
 * anything: a host still states its profile, and an identified answer is only
 * *eligible* to be admitted. An unidentified answer stays perfectly valid for
 * ordinary expansion — it simply cannot be what a generated fragment runs,
 * because there would be nothing for a continuation to be held to.
 */

import { retain, stillDescribes } from "./import-authority.ts";
import type { ImportedDefinition } from "./import-authority.ts";

/** A provider's stable statement about one implementation. */
export interface AnswerIdentity {
  readonly origin: string;
  readonly key: string;
  readonly revision: string;
}

/** What a provider is given to state an identity with. */
export interface AnswerClaimant {
  /**
   * State this identity for this exact answer.
   *
   * Called with the object the provider is about to return. Returns the same
   * object, so a handler states the claim in the position it already returns
   * from rather than keeping a second reference to compare later.
   */
  claim(answer: ImportedDefinition, identity: AnswerIdentity): ImportedDefinition;
}

/** A claim this execution recorded, with core's own copy of what was claimed. */
interface Claim {
  readonly identity: AnswerIdentity;
  readonly canonical: ImportedDefinition | undefined;
}

/** A claimant used after the execution that minted it ended. */
export const REVOKED_CLAIMANT =
  "the execution that minted this identity claimant has ended, so nothing it states identifies " +
  "an implementation here";

/** An identity a provider stated in a shape this execution cannot record. */
export class AnswerIdentityError extends Error {
  override name = "AnswerIdentityError";
}

/**
 * Every identity stated in one execution, and the ability to end them.
 *
 * Weak and keyed by the answer object: an identity belongs to the exact thing
 * that was claimed, never to a name, a shape or a description of one.
 */
export class AnswerIdentities {
  readonly #claims = new WeakMap<object, Claim>();
  #active = true;

  /**
   * A claimant for this execution.
   *
   * One object rather than a fresh one per provider: what bounds a claim is the
   * execution, and handing out per-provider claimants would suggest a provider
   * could be revoked on its own when it cannot.
   */
  claimant(): AnswerClaimant {
    return {
      claim: (answer: ImportedDefinition, identity: AnswerIdentity): ImportedDefinition => {
        if (!this.#active) {
          throw new AnswerIdentityError(REVOKED_CLAIMANT);
        }
        // Copied on the way in, so a later mutation of the object the provider
        // claimed is visible as the change it is.
        this.#claims.set(answer, {
          identity: complete(identity),
          canonical: retain(answer),
        });
        return answer;
      },
    };
  }

  /**
   * The identity stated for this exact answer, if this execution still holds
   * one and the answer still describes what was claimed.
   *
   * Read after the whole public chain has returned, so what is asked about is
   * the final answer rather than any intermediate one. Nothing here refuses —
   * an unidentified answer is an ordinary answer, and whether that is enough is
   * the caller's question.
   */
  identify(answer: unknown): AnswerIdentity | undefined {
    if (!this.#active || typeof answer !== "object" || answer === null) {
      return undefined;
    }
    const claim = this.#claims.get(answer);
    if (claim === undefined) {
      return undefined;
    }
    // A claimed object the chain went on to edit is not the thing that was
    // claimed. Reading it runs whatever it is made of, and a value that refuses
    // to be compared has failed the comparison.
    if (claim.canonical === undefined || !stillDescribes(claim.canonical, answer)) {
      return undefined;
    }
    return claim.identity;
  }

  /** End every claim this execution holds. Called at its teardown. */
  revoke(): void {
    this.#active = false;
  }

  /** Whether this execution still identifies anything. */
  get active(): boolean {
    return this.#active;
  }
}

/**
 * The identity as this execution records it, or the reason it cannot.
 *
 * Three non-empty strings, checked here rather than trusted: what a continuation
 * is compared against must be a value a reader can look at and say which part
 * moved, and a partial identity would compare equal to another partial one.
 */
function complete(identity: AnswerIdentity): AnswerIdentity {
  const { origin, key, revision } = identity;
  if (
    typeof origin !== "string" ||
    origin.length === 0 ||
    typeof key !== "string" ||
    key.length === 0 ||
    typeof revision !== "string" ||
    revision.length === 0
  ) {
    throw new AnswerIdentityError(
      "an identity states a non-empty origin, key and revision. A continuation is compared " +
        "against all three, so a partial one would compare equal to a different partial one.",
    );
  }
  return Object.freeze({ origin, key, revision });
}

/** The retained spelling of one identity, for a durable record. */
export function identityRecord(identity: AnswerIdentity): string {
  return `${identity.origin}#${identity.key}@${identity.revision}`;
}

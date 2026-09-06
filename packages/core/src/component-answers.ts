/**
 * How a trusted host says what is behind a provider-backed fragment entry.
 *
 * A `component-answer` entry names something the ordinary import chain resolves
 * rather than an operation core supplies a body for. The host does not hand
 * over the implementation — it states which name, and which structural identity
 * a provider must have claimed for that name. This module is the seam a
 * provider uses to make that claim.
 *
 * ## What a provider gets, and what it does not
 *
 * It gets one claimant, minted by canonical execution for this installation and
 * fixed to this installation's origin. So a provider states a key and a
 * revision and cannot assert another provider's origin. The claimant is an
 * ordinary closure: there is no shared symbol, module registry or context name
 * behind it, which is what lets a separately loaded copy of core hold one
 * without any of those being a way in.
 *
 * Claiming identifies an answer. It authorizes nothing. A fragment still needs
 * the host entry, an exact identity match, the right `allow` class, whole-
 * fragment preflight and canonical generated import — all of them independently.
 */

import type { Operation } from "effection";

import type { ClaimAnswer, ImportedDefinition } from "./components/import-authority.ts";

/**
 * What canonical execution hands a provider during profile capture.
 *
 * The `name` is the component the answer is for; the identity is the two parts
 * the provider owns. The same object comes back, so a handler states its claim
 * in the position it already returns from.
 */
export interface ComponentAnswerClaim {
  claim(
    name: string,
    answer: ImportedDefinition,
    identity: { readonly key: string; readonly revision: string },
  ): ImportedDefinition;
}

/**
 * One provider's installation, run during capture and before ordinary installs.
 *
 * `origin` is the provider's name for itself and becomes the origin on every
 * identity its claimant states. `install` is where the provider composes
 * whatever `Component.importComponent` middleware answers for its names, using
 * the claimant to identify what it returns.
 */
export interface ComponentAnswerInstallation {
  readonly origin: string;
  install(claim: ComponentAnswerClaim): Operation<void>;
}

/** Adapt one owner-minted claim function to the host-facing shape. */
export function componentAnswerClaim(claim: ClaimAnswer): ComponentAnswerClaim {
  return {
    claim(name, answer, identity) {
      return claim(name, answer, identity);
    },
  };
}

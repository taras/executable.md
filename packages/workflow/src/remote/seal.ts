/**
 * How a transaction reaches into the attempt it was given, and nothing else can.
 *
 * A transaction needs two things from a disposable attempt: to seal it into a
 * proposal once the body has finished, and to make it the accepted Workspace
 * once the owner has performed that exact proposal. Neither may be offered to
 * whoever is running the body — a capability handed out is a capability that
 * can be used at the wrong moment, and the wrong moment here is any moment
 * before the owner has decided.
 *
 * So they hang off a symbol. A symbol cannot be written down by code that does
 * not already have it, this module is reachable from no package entrypoint, and
 * the declared `Attempt` says nothing about it. What a caller receives is a
 * place to work and a way to read what it did.
 */

import type { Operation } from "effection";
import type { CommitDecision, RetainedMapping, WorkspacePublication } from "./publication.ts";

/** The key a transaction reaches an attempt's own machinery through. */
export const SEAL: unique symbol = Symbol("executablemd.workflow.remote.seal");

/** One attempt, sealed into the proposal the owner will decide. */
export interface SealedProposal {
  readonly publication: WorkspacePublication;
  readonly mappings: readonly RetainedMapping[];
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  /**
   * Make the sealed attempt the accepted Workspace.
   *
   * Called once, by the transaction, after the owner performed this exact
   * proposal and the answer was checked against it. The decision is compared
   * with what was sealed, so an answer about another Workspace moves nothing.
   */
  transfer(decision: CommitDecision): Operation<void>;
}

/** What an attempt privately offers the transaction that was given it. */
export interface SealableAttempt {
  readonly [SEAL]: (mappings: readonly RetainedMapping[]) => Operation<SealedProposal>;
}

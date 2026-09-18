/**
 * The identities this execution's admitted history holds.
 *
 * A Git-host effect is named by a digest that includes the run id, so a record
 * a fork inherited has to be recognized by the identity it was written under.
 * An Issue effect is a different request shape reconciled through a different
 * boundary, and what it needs from the history is the same association.
 *
 * Both are read out of the retained snapshot by a journal admission, which
 * canonical core applies inside the execution's own journal read — on the exact
 * frozen events every later phase consumes, before any middleware, any retained
 * Yield reaching execution, any authored work and any append. The value the
 * admission installs is therefore this execution's, computed from this
 * execution's history, and a second execution under the same Plugin computes
 * its own from its own.
 *
 * Nothing durable rests on either. A wrong answer is held to the record it
 * consumed, and one that reaches live execution performs nothing: what holds an
 * effect to its history is the admission and the record, neither of which is
 * reachable from a name a document could bind.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { JournalAdmission } from "@executablemd/core/host";
import { retainedGitHostIdentities } from "./git-host/identities.ts";
import type { RetainedIdentity } from "./git-host/identities.ts";
import { retainedIssueIdentities } from "./issue/identities.ts";
import type { RetainedIssueIdentity } from "./issue/identities.ts";

/**
 * Where this execution's retained Git-host identities are kept.
 *
 * A stable, namespaced name and a plain value, so a second physical copy of
 * this package reads the same binding through its own descriptor and finds the
 * same answer rather than one queue per module object. By the same property a
 * descendant may bind the name for its own descendants — which is why nothing
 * durable depends on what it holds.
 */
const RetainedGitHostIdentities: Context<readonly RetainedIdentity[] | undefined> = createContext<
  readonly RetainedIdentity[] | undefined
>("executablemd.git.git-host.retained-identities", undefined);

/** Where this execution's retained Issue identities are kept, on the same terms. */
const RetainedIssueIdentities: Context<readonly RetainedIssueIdentity[] | undefined> =
  createContext<readonly RetainedIssueIdentity[] | undefined>(
    "executablemd.git.issue.retained-identities",
    undefined,
  );

/** The Git-host identities this execution's admitted history holds. */
export function* retainedGitHostIdentitiesHere(): Operation<RetainedIdentity[] | undefined> {
  const held = yield* RetainedGitHostIdentities.get();
  return held === undefined ? undefined : [...held];
}

/** The Issue identities this execution's admitted history holds. */
export function* retainedIssueIdentitiesHere(): Operation<RetainedIssueIdentity[] | undefined> {
  const held = yield* RetainedIssueIdentities.get();
  return held === undefined ? undefined : [...held];
}

/**
 * Publish the Git-host identities this execution's history holds.
 *
 * One value per execution, derived from the snapshot this admission was handed
 * and set into the scope that owns the document. A Plugin is installed once per
 * command and may run two documents; each of those is its own execution with
 * its own journal read, so each runs this and each installs its own value.
 */
export function gitHostIdentityAdmission(): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    yield* RetainedGitHostIdentities.set(Object.freeze(retainedGitHostIdentities(retained)));
  };
}

/** Publish the Issue identities this execution's history holds, on the same terms. */
export function issueIdentityAdmission(): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    yield* RetainedIssueIdentities.set(Object.freeze(retainedIssueIdentities(retained)));
  };
}

/**
 * The identities this execution's admitted history holds.
 *
 * A Git-host effect is named by a digest that includes the run id, so a record
 * a fork inherited has to be recognized by the identity it was written under.
 * An Issue effect is a different request shape reconciled through a different
 * boundary, and what it needs from the history is the same association.
 *
 * Both are read out of the saved snapshot by a journal admission, which
 * canonical core applies inside the execution's own journal read — on the exact
 * frozen events every later phase consumes, before any middleware, any saved
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
import { savedGitHostIdentities } from "./git-host/identities.ts";
import type { SavedIdentity } from "./git-host/identities.ts";
import { savedIssueIdentities } from "./issue/identities.ts";
import type { SavedIssueIdentity } from "./issue/identities.ts";

/**
 * Where this execution's saved Git-host identities are kept.
 *
 * A stable, namespaced name and a plain value, so a second physical copy of
 * this package reads the same binding through its own descriptor and finds the
 * same answer rather than one queue per module object. By the same property a
 * descendant may bind the name for its own descendants — which is why nothing
 * durable depends on what it holds.
 */
const SavedGitHostIdentities: Context<readonly SavedIdentity[] | undefined> = createContext<
  readonly SavedIdentity[] | undefined
>("executablemd.git.git-host.saved-identities", undefined);

/** Where this execution's saved Issue identities are kept, on the same terms. */
const SavedIssueIdentities: Context<readonly SavedIssueIdentity[] | undefined> = createContext<
  readonly SavedIssueIdentity[] | undefined
>("executablemd.git.issue.saved-identities", undefined);

/** The Git-host identities this execution's admitted history holds. */
export function* savedGitHostIdentitiesHere(): Operation<SavedIdentity[] | undefined> {
  const held = yield* SavedGitHostIdentities.get();
  return held === undefined ? undefined : [...held];
}

/** The Issue identities this execution's admitted history holds. */
export function* savedIssueIdentitiesHere(): Operation<SavedIssueIdentity[] | undefined> {
  const held = yield* SavedIssueIdentities.get();
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
  return function* (saved: readonly DurableEvent[]): Operation<void> {
    yield* SavedGitHostIdentities.set(Object.freeze(savedGitHostIdentities(saved)));
  };
}

/** Publish the Issue identities this execution's history holds, on the same terms. */
export function issueIdentityAdmission(): JournalAdmission {
  return function* (saved: readonly DurableEvent[]): Operation<void> {
    yield* SavedIssueIdentities.set(Object.freeze(savedIssueIdentities(saved)));
  };
}

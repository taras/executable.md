/**
 * A provider's private map from the selections it minted to what it holds
 * behind them.
 *
 * `RepositorySelection` is composition data: a document may bind one, render
 * one, hand one to a child, and — since it is an ordinary frozen object — build
 * one that looks exactly like it. So nothing a provider does may be authorized
 * by the value it was handed. This is the other half of that contract: the
 * provider keeps the authority here, in its own closure, and every operation
 * asks this registry what a selection names before it touches Git or a service.
 *
 * The identifier is random and opaque. It is not derived from the name, the
 * locator, the path or anything else a document can see, so a selection cannot
 * be constructed — only reproduced from one the provider already handed out.
 * Reproducing one is enough to name a target, which is exactly as much as a
 * selection is meant to carry: the registry answers with what the provider
 * itself recorded, never with what the caller's copy claims.
 *
 * The comparison is total, not a spot check. An identifier that matches while
 * a name, a checkout path or one member of the identity does not is a value
 * somebody edited, and acting on the provider's own record while the caller
 * believes it named something else is exactly the confusion a selection must
 * not be able to cause.
 */

import { randomUUID } from "node:crypto";
import {
  REPOSITORY_IDENTITY_MEMBERS,
  repositorySelection,
  type RepositoryIdentity,
  type RepositorySelection,
} from "../composition/selection.ts";

export interface SelectionRegistry<T> {
  /**
   * The selection naming this target, minted once per key.
   *
   * Selecting the same target twice in one execution answers with the same
   * selection, so a provider recognizes a lease it is already holding rather
   * than acquiring a second one. What is held behind it is replaced, because
   * the second selection revalidated and its facts are the newer ones.
   */
  mint(
    key: string,
    name: string,
    identity: RepositoryIdentity,
    checkoutPath: string,
    held: T,
  ): RepositorySelection;

  /**
   * What this selection names, or the caller's own refusal.
   *
   * The refusal is the caller's because the vocabulary is: `<Git.Switch>` and
   * `<Worktree>` describe an unusable Repository in different words, and a
   * registry that invented one would be a second way for the same condition to
   * be reported.
   */
  authenticate(selection: RepositorySelection, refuse: () => Error): T;
}

interface Entry<T> {
  readonly selection: RepositorySelection;
  held: T;
}

export function selectionRegistry<T>(): SelectionRegistry<T> {
  const byKey = new Map<string, Entry<T>>();
  const byIdentifier = new Map<string, Entry<T>>();

  return {
    mint(key, name, identity, checkoutPath, held) {
      const existing = byKey.get(key);
      if (existing !== undefined) {
        existing.held = held;
        return existing.selection;
      }
      const entry: Entry<T> = {
        selection: repositorySelection(randomUUID(), name, identity, checkoutPath),
        held,
      };
      byKey.set(key, entry);
      byIdentifier.set(entry.selection.selection, entry);
      return entry.selection;
    },

    authenticate(selection, refuse) {
      const entry = byIdentifier.get(selection.selection);
      if (entry === undefined) {
        throw refuse();
      }
      const minted = entry.selection;
      if (
        selection.name !== minted.name ||
        selection.checkoutPath !== minted.checkoutPath ||
        !REPOSITORY_IDENTITY_MEMBERS.every(
          (member) => selection.identity[member] === minted.identity[member],
        )
      ) {
        throw refuse();
      }
      return entry.held;
    },
  };
}

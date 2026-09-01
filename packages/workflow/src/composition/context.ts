/**
 * The contextual Repository a lexical `<Repository>` installs for its content,
 * and how an element written outside one finds a Repository anyway.
 *
 * A stable, namespaced contextual value holding a {@link RepositorySelection}
 * and no authority. `<Worktree>` and every Git element read it to learn which
 * Repository they belong to; the provider decides separately whether anything
 * may be done to that Repository, so a replaced context can misname a
 * Repository but cannot grant access to one.
 *
 * Installed with `{ at: "min" }` wherever it is installed, so the nearest
 * enclosing Repository answers and the outer one is restored when that scope
 * ends. Nesting one Repository inside another therefore means what it reads as.
 *
 * With no lexical Repository in scope the installed provider is asked for its
 * ambient one. An ordinary `xmd run` from a Git checkout has one — the
 * repository the invocation started in — which is what lets a document write a
 * root-level `<Worktree>` or `<Git.Commit>` and mean the checkout the person
 * running it is standing in. A workflow run has none, because a workflow names
 * every repository it touches.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { RepositoryComposition } from "./api.ts";
import type { RepositorySelection } from "./selection.ts";

export interface RepositoryContextApi {
  readonly current: RepositorySelection | undefined;
}

export const RepositoryContext: Api<RepositoryContextApi> = createApi<RepositoryContextApi>(
  "executablemd.workflow.composition.context",
  { current: undefined },
);

/** The currently enclosing lexical Repository, or `undefined` when there is none. */
export function currentRepository(): Operation<RepositorySelection | undefined> {
  return RepositoryContext.operations.current;
}

/**
 * The Repository this element acts on: the lexical one, or the host's own.
 *
 * `undefined` means neither exists, and the calling component's own refusal is
 * what says so — each of them has a different sentence for what it needed a
 * repository *for*. A host that has ambient Repositories and is not in one
 * refuses from the provider instead, naming how to run inside one.
 */
export function* selectedRepository(): Operation<RepositorySelection | undefined> {
  const lexical = yield* RepositoryContext.operations.current;
  if (lexical !== undefined) {
    return lexical;
  }
  return yield* RepositoryComposition.operations.ambientRepository();
}

/**
 * The profile-neutral Repository/Worktree composition Api.
 *
 * Repository and Worktree components ask this Api for work; the installed
 * provider decides how to do it. This package names no subprocess, no host
 * filesystem and no runtime: whichever host has the authority to touch a Git
 * checkout installs a concrete provider, and there are two of them. A workflow
 * host installs one inside its `withWorkflowWorkspace()` attachment, where a
 * checkout is a retained Workspace root; the Deno and compiled `xmd run`
 * entrypoints install another, where a checkout is a directory on the caller's
 * own filesystem held open by an advisory lock.
 *
 * Every operation answers with a {@link RepositorySelection} — plain structural
 * data naming a target, carrying no authority. What a provider does with a
 * selection it is handed afterwards is authenticate it against private state,
 * so a selection that was copied, replaced or rebuilt can misname a target and
 * be refused; it cannot reach one.
 *
 * The default handler throws. There is no in-memory fallback: a Repository that
 * "starts" without a provider would retain nothing while claiming it had, and a
 * host that installs none must be distinguishable from one whose repository is
 * merely not there.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { RepositoryCompositionProviderError } from "./errors.ts";
import type { RepositorySelection } from "./selection.ts";

/**
 * What a `<Repository>` invocation asks the provider to select.
 *
 * Parsed at the component boundary from the caller's props and expressions. The
 * provider receives only the bytes it acts on; the locator is still raw here,
 * because admitting it is the provider's job and refusing an unusable one is
 * one of the answers it gives.
 */
export interface RepositoryRequest {
  readonly name: string;
  readonly locator: string;
  readonly base: string | undefined;
}

/**
 * What a `<Worktree>` invocation asks the provider to select.
 *
 * The Repository is the selection the enclosing lexical `<Repository>` — or the
 * ambient one — already produced, rather than a name from props: a Worktree
 * exists inside a Repository, and letting a document write the name would let it
 * name a Repository that is not in scope.
 */
export interface WorktreeRequest {
  readonly name: string;
  readonly branch: string;
  readonly base: string | undefined;
}

export interface RepositoryCompositionApi {
  /**
   * Select the Repository this lexical invocation names, creating it when the
   * provider has none.
   *
   * One operation rather than a creation and an attachment, because a component
   * has one question: which repository am I acting on. A workflow provider
   * still performs both halves inside it — one durable effect that clones,
   * resolves, pins and retains, then an ephemeral reattachment that proves the
   * retained state is still there — and a live provider acquires a lease,
   * revalidates a compatible reuse and hands back the same directory.
   */
  selectRepository(request: RepositoryRequest): Operation<RepositorySelection>;

  /** Select a named linked checkout of an already-selected Repository. */
  selectWorktree(
    repository: RepositorySelection,
    request: WorktreeRequest,
  ): Operation<RepositorySelection>;

  /**
   * The Repository the host is already standing in, for an element written
   * outside a lexical `<Repository>`.
   *
   * Three answers, and they are three different situations. A selection means
   * this profile has an ambient Repository and this invocation is in one. A
   * throw means it has ambient Repositories and this invocation is not in one,
   * and the sentence says how to run inside one. `undefined` means the profile
   * has no such thing at all — a workflow document names its repositories, and
   * the component's own refusal is what says so.
   */
  ambientRepository(): Operation<RepositorySelection | undefined>;
}

export const RepositoryComposition: Api<RepositoryCompositionApi> =
  createApi<RepositoryCompositionApi>("executablemd.workflow.composition.repository", {
    // deno-lint-ignore require-yield
    *selectRepository(_request: RepositoryRequest): Operation<RepositorySelection> {
      throw new RepositoryCompositionProviderError("<Repository>");
    },
    // deno-lint-ignore require-yield
    *selectWorktree(
      _repository: RepositorySelection,
      _request: WorktreeRequest,
    ): Operation<RepositorySelection> {
      throw new RepositoryCompositionProviderError("<Worktree>");
    },
    // deno-lint-ignore require-yield
    *ambientRepository(): Operation<RepositorySelection | undefined> {
      throw new RepositoryCompositionProviderError("an element written outside a <Repository>");
    },
  });

/**
 * The sixteen repository-composition components, as one array of ordinary
 * declarations.
 *
 * Repository, Worktree, the four Git operations, the four Git reads,
 * PullRequest and its three evidence reads, IssueTracker and Issue are
 * ordinary registered defaults — not
 * reserved and not structural — so a repository-local component may shadow one
 * for its own scope. `<Dir>` is not among them: canonical core reserves that
 * name (`core/src/components/fixed-filesystem.ts`), and a document reaches it
 * with or without this package.
 *
 * One array, three consumers, because three descriptions of one vocabulary
 * would drift. `useCompositionComponents()` registers it inside a workflow
 * attachment; `useCommandComponents()` registers it for `xmd syntax` and for
 * `xmd plan`'s validation and generation; `installDocumentComponents()`
 * registers it for an ordinary run. Registering it installs no provider,
 * performs no repository discovery, acquires no lock and reaches no network:
 * what a name *does* is the installed provider's, and describing the
 * environment mints none.
 *
 * A completed root replay attaches no provider and registers nothing, so a
 * document that already ran through completion re-registers none of these.
 */

import type { Operation } from "effection";
import {
  contributeDocumentation,
  documented,
  formDispatcher,
  packageDocumentation,
  registerComponents,
} from "@executablemd/core";
import type {
  ComponentRegistration,
  DocumentationContribution,
  DocumentationReader,
} from "@executablemd/core";
import { COMPOSITION_ORIGIN } from "./definitions.ts";
import Repository, { props as repositoryProps } from "./components/Repository.ts";
import Worktree, { props as worktreeProps } from "./components/Worktree.ts";
import GitSwitch, { props as gitSwitchProps } from "./components/GitSwitch.ts";
import GitAdd, { props as gitAddProps } from "./components/GitAdd.ts";
import GitCommit, {
  props as gitCommitProps,
  returns as gitCommitReturns,
} from "./components/GitCommit.ts";
import GitPush, {
  documentation as gitPushDocumentation,
  props as gitPushProps,
} from "./components/GitPush.ts";
import PullRequest, {
  props as pullRequestProps,
  returns as pullRequestReturns,
} from "./components/PullRequest.ts";
import Issue, {
  documentation as issueDocumentation,
  props as issueProps,
  returns as issueReturns,
} from "./components/Issue.ts";
import {
  checksForm,
  checksReturns,
  commentsForm,
  commentsReturns,
  props as pullRequestReadProps,
  reviewsForm,
  reviewsReturns,
} from "./components/PullRequestReads.ts";
import IssueTracker, { props as issueTrackerProps } from "./components/IssueTracker.ts";
import { changesForm, diffForm, fileForm, filesForm } from "./components/GitReads.ts";
import {
  changesProps,
  changesReturns,
  diffProps,
  diffReturns,
  fileProps,
  fileReturns,
  filesProps,
  filesReturns,
} from "./observation-api.ts";

/**
 * This boundary's long-form documentation, and the components it must cover.
 *
 * Derived from `COMPOSITION_REGISTRATIONS` below rather than listed again, so a
 * component added to that array cannot be left undocumented here.
 */
export function* compositionDocumentation(
  read?: DocumentationReader,
): Operation<DocumentationContribution> {
  return yield* packageDocumentation(
    new URL("./components.md", import.meta.url),
    {
      owner: COMPOSITION_ORIGIN,
      asset: "packages/git/src/composition/components.md",
    },
    COMPOSITION_REGISTRATIONS.map((registration) => registration.name),
    read,
  );
}

export const COMPOSITION_REGISTRATIONS: readonly ComponentRegistration[] = [
  {
    name: "Repository",
    origin: COMPOSITION_ORIGIN,
    props: repositoryProps,
    fn: Repository,
    ...documented({
      description: `Clone or use a repository. \`<Repository name="project" url={props.repository}>…</Repository>\` expands its content in the specified checkout.`,
      as: "Optional. The path of the selected checkout.",
      context: "The Markdown expanded in that checkout.",
    }),
  },
  {
    name: "Worktree",
    origin: COMPOSITION_ORIGIN,
    props: worktreeProps,
    fn: Worktree,
    ...documented({
      description: `Create or use a worktree. \`<Worktree name="review" branch="issue-643">…</Worktree>\` expands its content in the worktree.`,
      as: "Optional. The path of the linked checkout.",
      context: "The Markdown expanded in that checkout.",
    }),
  },
  {
    name: "Git.Switch",
    origin: COMPOSITION_ORIGIN,
    props: gitSwitchProps,
    fn: GitSwitch,
    ...documented({
      description: `Switch or create a branch. \`<Git.Switch branch="release/1.4" base="main" />\` starts a missing branch at the specified base.`,
      as: null,
      context: null,
    }),
  },
  {
    name: "Git.Add",
    origin: COMPOSITION_ORIGIN,
    props: gitAddProps,
    fn: GitAdd,
    ...documented({
      description: `Stage paths for commit. \`<Git.Add paths={["packages/core", "deno.lock"]} />\` resolves Git pathspecs from the working directory.`,
      as: null,
      context: null,
    }),
  },
  {
    name: "Git.Commit",
    origin: COMPOSITION_ORIGIN,
    props: gitCommitProps,
    returns: gitCommitReturns,
    fn: GitCommit,
    ...documented({
      description: `Commit staged changes. \`<Git.Commit>Prepare 1.4</Git.Commit>\` uses its expanded content as the commit message.`,
      as: "Optional. The full object id of the commit.",
      context: "The message body, expanded before the commit is made.",
    }),
  },
  {
    name: "Git.Push",
    origin: COMPOSITION_ORIGIN,
    props: gitPushProps,
    fn: GitPush,
    ...documented(gitPushDocumentation),
  },
  {
    name: "Git.Files",
    origin: COMPOSITION_ORIGIN,
    props: filesProps,
    returns: filesReturns,
    fn: formDispatcher(filesForm),
    ...documented({
      description: `List tracked files. \`<Git.Files prefix="packages/core/" as="files" />\` lists the selected repository's tracked paths, bounded and continuable.`,
      as: "Required. The tracked paths, and the arguments of the next page or null.",
      context: null,
    }),
  },
  {
    name: "Git.Changes",
    origin: COMPOSITION_ORIGIN,
    props: changesProps,
    returns: changesReturns,
    fn: formDispatcher(changesForm),
    ...documented({
      description: `Compare what changed. \`<Git.Changes compare="staged" as="changes" />\` reports each changed path and its status for unstaged, staged or two commits.`,
      as: "Required. The comparison, each change's path, status and previous path, and the next page or null.",
      context: null,
    }),
  },
  {
    name: "Git.Diff",
    origin: COMPOSITION_ORIGIN,
    props: diffProps,
    returns: diffReturns,
    fn: formDispatcher(diffForm),
    ...documented({
      description: `Read a comparison's patch. \`<Git.Diff compare="staged" paths={["packages/core/"]} as="diff" />\` reads a window of the unified diff text.`,
      as: "Required. The comparison, the patch window, its offset, the whole length, and the next page or null.",
      context: null,
    }),
  },
  {
    name: "Git.File",
    origin: COMPOSITION_ORIGIN,
    props: fileProps,
    returns: fileReturns,
    fn: formDispatcher(fileForm),
    ...documented({
      description: `Read a committed file. \`<Git.File commit="HEAD~1" path="packages/core/src/expand.ts" as="source" />\` reads the text that commit holds, not the working copy.`,
      as: "Required. The resolved commit, the path, the text window, its offset, the whole length, and the next page or null.",
      context: null,
    }),
  },
  {
    name: "PullRequest",
    origin: COMPOSITION_ORIGIN,
    props: pullRequestProps,
    returns: pullRequestReturns,
    fn: PullRequest,
    ...documented({
      description: `Open or update a pull request. \`<PullRequest title="Prepare 1.4">…</PullRequest>\` uses its content as the body after \`<Git.Push />\`.`,
      as: "Optional. The pull request's repository, number, url, state and head and base commits.",
      context: "The pull request's body.",
    }),
  },
  {
    name: "PullRequest.Reviews",
    origin: COMPOSITION_ORIGIN,
    props: pullRequestReadProps,
    returns: reviewsReturns,
    fn: formDispatcher(reviewsForm),
    ...documented({
      description: `Read pull request reviews. \`<PullRequest.Reviews url={pullRequest.url} as="reviews" />\` reads reviews from the specified pull request.`,
      as: "Required. Each review's author, state, body, submission time, commit and url.",
      context: null,
    }),
  },
  {
    name: "PullRequest.Comments",
    origin: COMPOSITION_ORIGIN,
    props: pullRequestReadProps,
    returns: commentsReturns,
    fn: formDispatcher(commentsForm),
    ...documented({
      description: `Read pull request comments. \`<PullRequest.Comments url={pullRequest.url} as="comments" />\` reads both conversation and review comments.`,
      as: "Required. Each comment's kind, author, body, timestamps and url, and a review comment's file, hunk and line.",
      context: null,
    }),
  },
  {
    name: "PullRequest.Checks",
    origin: COMPOSITION_ORIGIN,
    props: pullRequestReadProps,
    returns: checksReturns,
    fn: formDispatcher(checksForm),
    ...documented({
      description: `Read pull request checks. \`<PullRequest.Checks url={pullRequest.url} as="checks" />\` reads check runs and commit statuses for its head.`,
      as: "Required. Each check's kind, name, head commit and outcome.",
      context: null,
    }),
  },
  {
    name: "IssueTracker",
    origin: COMPOSITION_ORIGIN,
    props: issueTrackerProps,
    fn: IssueTracker,
    ...documented({
      description: `Select an issue tracker. \`<IssueTracker url={props.tracker}>…</IssueTracker>\` expands its content with the specified tracker in scope.`,
      as: null,
      context: "The Markdown whose issues are filed there.",
    }),
  },
  {
    name: "Issue",
    origin: COMPOSITION_ORIGIN,
    props: issueProps,
    returns: issueReturns,
    fn: Issue,
    ...documented(issueDocumentation),
  },
];

/**
 * Register the composition vocabulary as ordinary defaults for this scope.
 *
 * The registrations and the documentation that describes them, installed
 * together so a scope that has one has the other. Both are declarations: this
 * installs no provider, discovers no ambient repository, acquires no lock,
 * spawns no Git and reads no credential, which is what lets `xmd syntax` enter
 * it to describe the profile.
 */
export function* useCompositionComponents(): Operation<void> {
  yield* registerComponents(COMPOSITION_REGISTRATIONS);
  yield* contributeDocumentation(compositionDocumentation);
}

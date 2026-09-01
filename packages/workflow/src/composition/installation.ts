/**
 * The thirteen repository-composition components, as one array of ordinary
 * declarations.
 *
 * Repository, Worktree, Dir, the four Git operations, PullRequest and its three
 * evidence reads, IssueTracker and Issue are ordinary registered defaults — not
 * reserved and not structural — so a repository-local component may shadow one
 * for its own scope.
 *
 * One array rather than a list per caller, because two descriptions of one
 * vocabulary would drift. `useCompositionComponents()` registers it inside a
 * workflow attachment. Registering it installs no provider, performs no
 * repository discovery, acquires no lock and reaches no network: what a name
 * *does* is the installed provider's, and describing the environment mints
 * none.
 *
 * A completed root replay attaches no provider and registers nothing, so a
 * document that already ran through completion re-registers none of these.
 */

import type { Operation } from "effection";
import { documented, formDispatcher, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { COMPOSITION_ORIGIN, dirDefinition } from "./definitions.ts";
import Repository, { props as repositoryProps } from "./components/Repository.ts";
import Worktree, { props as worktreeProps } from "./components/Worktree.ts";
import GitSwitch, { props as gitSwitchProps } from "./components/GitSwitch.ts";
import GitAdd, { props as gitAddProps } from "./components/GitAdd.ts";
import GitCommit, {
  props as gitCommitProps,
  returns as gitCommitReturns,
} from "./components/GitCommit.ts";
import GitPush, { props as gitPushProps } from "./components/GitPush.ts";
import PullRequest, {
  props as pullRequestProps,
  returns as pullRequestReturns,
} from "./components/PullRequest.ts";
import Issue, { props as issueProps, returns as issueReturns } from "./components/Issue.ts";
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

// The same definition the generated-XMD write table pins, so the ordinary
// component and the pinned identity cannot drift apart.
const dir = dirDefinition();

/** The one vocabulary every consumer of these components describes. */
export const COMPOSITION_REGISTRATIONS: readonly ComponentRegistration[] = [
  {
    name: "Repository",
    origin: COMPOSITION_ORIGIN,
    props: repositoryProps,
    fn: Repository,
    ...documented({
      description:
        "Work in a Git repository by name and url. " +
        '`<Repository name="project" url={props.repository}>…</Repository>` clones it once, ' +
        "then expands its content with that checkout as the working directory. Written " +
        '`<Repository name="project" url={..} as="project" />` it renders nothing and binds ' +
        "the checkout path instead. A second invocation naming the same repository and url " +
        "reuses the same checkout, keeping the commits, branches and uncommitted work the " +
        "first one left there.",
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
      description:
        "Work on a branch in a linked checkout of its own. " +
        '`<Worktree name="review" branch="issue-643" as="review" />` creates the branch when ' +
        "it is missing and checks it out beside the repository, so several branches are open " +
        "at once without one switch disturbing another. `branch` is required and `name` never " +
        "selects one. Written outside a `<Repository>` it belongs to the repository the " +
        "command was run in, where the host has one.",
      as: "Optional. The path of the linked checkout.",
      context: "The Markdown expanded in that checkout.",
    }),
  },
  {
    name: dir.name,
    origin: COMPOSITION_ORIGIN,
    props: dir.props,
    fn: dir.fn,
    ...documented({
      description:
        "Run its content in another directory. " +
        "`<Dir path={worktree}>…</Dir>` expands the Markdown inside with `path` as the " +
        "working directory, and restores the enclosing one afterwards. A relative path is " +
        "read against the directory already in effect. It selects no repository: Git " +
        "elements inside still belong to the enclosing `<Repository>`.",
      as: null,
      context: "The Markdown expanded in that directory.",
    }),
  },
  {
    name: "Git.Switch",
    origin: COMPOSITION_ORIGIN,
    props: gitSwitchProps,
    fn: GitSwitch,
    ...documented({
      description:
        "Put the checkout on a named branch. " +
        '`<Git.Switch branch="release/1.4" base="main" />` switches to the branch, creating ' +
        "it at `base` when it does not exist yet. A branch another checkout already holds, " +
        "and local changes the switch would overwrite, are both refused rather than forced.",
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
      description:
        "Stage exactly the paths you name. " +
        '`<Git.Add paths={["packages/core", "deno.lock"]} />` stages them as written, from ' +
        "the directory the element appears in. `paths` is a Git pathspec and is required; " +
        '`"."` is how a document says everything here.',
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
      description:
        "Commit what is staged, and hand back the commit. " +
        '`<Git.Commit message="Prepare 1.4" as="commit">…</Git.Commit>` commits the index ' +
        "alone — nothing is staged for it and nothing is amended. Content expands first and " +
        "becomes the message body, so a `<Git.Add>` written inside stages before the commit " +
        "exists. An index that already matches HEAD is refused rather than committed empty.",
      as: "Optional. The full object id of the commit.",
      context: "The message body, expanded before the commit is made.",
    }),
  },
  {
    name: "Git.Push",
    origin: COMPOSITION_ORIGIN,
    props: gitPushProps,
    fn: GitPush,
    ...documented({
      description:
        "Publish the checkout's current branch to its origin. " +
        "`<Git.Push />` takes no props: the remote is the repository's `origin`, the branch " +
        "is the one the checkout is on, and the commit is the one that branch points at. It " +
        "never force-pushes and changes no upstream tracking; a destination naming a commit " +
        "this run did not publish from is refused.",
      as: null,
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
      description:
        "Open a pull request for the branch this run published, or bring one up to date. " +
        '`<PullRequest title="Prepare 1.4" as="pullRequest">…</PullRequest>` asks for one ' +
        "pull request from the checkout's branch to `base` to exist; with `number` it updates " +
        "that pull request instead. The content is the body. It publishes nothing itself: " +
        "write `<Git.Push />` first, and this run must hold that push's own successful " +
        "result for the same branch and commit.",
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
      description:
        "Read the reviews a pull request holds. " +
        '`<PullRequest.Reviews url={pullRequest.url} as="reviews" />` binds one array to ' +
        "iterate with `<Each>`, so an objection reaches an agent's prompt. The url is the " +
        "identity — there is no repository or number prop, and no `<Repository>` to be " +
        "inside of. `as` is required.",
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
      description:
        "Read the comments a pull request holds. " +
        '`<PullRequest.Comments url={pullRequest.url} as="comments" />` binds one array of ' +
        "both conversation comments and review comments, each saying which kind it is. The " +
        "url is the identity. `as` is required.",
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
      description:
        "Read the checks reported against a pull request's head. " +
        '`<PullRequest.Checks url={pullRequest.url} as="checks" />` binds one array of both ' +
        "check runs and commit statuses, each saying which kind it is. The url is the " +
        "identity. `as` is required.",
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
      description:
        "Say which tracker the issues in its content are filed in. " +
        "`<IssueTracker url={props.tracker}>…</IssueTracker>` names the container new issues " +
        "are created in — a GitHub repository's issues, an Atlassian project. `provider` " +
        "names the only adapter allowed to act on it, for a url nobody recognizes. A nested " +
        "tracker replaces the whole target for its own content rather than merging with it.",
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
    ...documented({
      description:
        "Read an issue by url, or file one in the tracker in scope. " +
        '`<Issue url={finding.issueUrl} as="found" />` reads the one that url names and needs ' +
        'no tracker. `<Issue title="Retry the publish step" as="filed">…</Issue>` inside an ' +
        "`<IssueTracker>` files an issue whose content is its description, creating it once " +
        "and bringing it up to date afterwards. Which of the two it is, is decided by the " +
        "spelling: a url reads, a title files.",
      as: "Required for a read, which binds url, title, description, tags and assignee. A file binds the url alone.",
      context: "The issue's description, for the form that files one.",
    }),
  },
];

/** Register the composition vocabulary as ordinary defaults for this scope. */
export function useCompositionComponents(): Operation<void> {
  return registerComponents(COMPOSITION_REGISTRATIONS);
}

/**
 * Registers the composition components as ordinary defaults.
 *
 * Repository, Worktree, Dir, the Git operations, PullRequest, IssueTracker and
 * Issue are ordinary
 * registered defaults — not reserved and not structural — so a repository-local component
 * may shadow one for its own scope, and the workflow host installs them only
 * for a live or partial attachment. A completed root replay does not attach any
 * provider, so a document that already ran through completion does not
 * re-register them either.
 */

import type { Operation } from "effection";
import { registerComponents } from "@executablemd/core";
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
import IssueTracker, { props as issueTrackerProps } from "./components/IssueTracker.ts";

export function useCompositionComponents(): Operation<void> {
  // The same definition the generated-XMD write table pins, so the ordinary
  // component and the pinned identity cannot drift apart.
  const dir = dirDefinition();
  return registerComponents([
    {
      name: "Repository",
      origin: COMPOSITION_ORIGIN,
      props: repositoryProps,
      fn: Repository,
    },
    {
      name: "Worktree",
      origin: COMPOSITION_ORIGIN,
      props: worktreeProps,
      fn: Worktree,
    },
    {
      name: dir.name,
      origin: COMPOSITION_ORIGIN,
      props: dir.props,
      fn: dir.fn,
    },
    {
      name: "Git.Switch",
      origin: COMPOSITION_ORIGIN,
      props: gitSwitchProps,
      fn: GitSwitch,
    },
    {
      name: "Git.Add",
      origin: COMPOSITION_ORIGIN,
      props: gitAddProps,
      fn: GitAdd,
    },
    {
      name: "Git.Commit",
      origin: COMPOSITION_ORIGIN,
      props: gitCommitProps,
      returns: gitCommitReturns,
      fn: GitCommit,
    },
    {
      name: "Git.Push",
      origin: COMPOSITION_ORIGIN,
      props: gitPushProps,
      fn: GitPush,
    },
    {
      name: "PullRequest",
      origin: COMPOSITION_ORIGIN,
      props: pullRequestProps,
      returns: pullRequestReturns,
      fn: PullRequest,
    },
    {
      name: "IssueTracker",
      origin: COMPOSITION_ORIGIN,
      props: issueTrackerProps,
      fn: IssueTracker,
    },
    {
      name: "Issue",
      origin: COMPOSITION_ORIGIN,
      props: issueProps,
      returns: issueReturns,
      fn: Issue,
    },
  ]);
}

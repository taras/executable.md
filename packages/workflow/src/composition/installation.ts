/**
 * Registers the composition components as ordinary defaults.
 *
 * Repository, Worktree, Dir and the Git operations are ordinary registered
 * defaults — not reserved and not structural — so a repository-local component
 * may shadow one for its own scope, and the workflow host installs them only
 * for a live or partial attachment. A completed root replay does not attach any
 * provider, so a document that already ran through completion does not
 * re-register them either.
 */

import type { Operation } from "effection";
import { registerComponents } from "@executablemd/core";
import Repository, { props as repositoryProps } from "./components/Repository.ts";
import Worktree, { props as worktreeProps } from "./components/Worktree.ts";
import Dir, { props as dirProps } from "./components/Dir.ts";
import GitSwitch, { props as gitSwitchProps } from "./components/GitSwitch.ts";
import GitAdd, { props as gitAddProps } from "./components/GitAdd.ts";
import GitCommit, {
  props as gitCommitProps,
  returns as gitCommitReturns,
} from "./components/GitCommit.ts";

const ORIGIN = "@executablemd/workflow/composition";

export function useCompositionComponents(): Operation<void> {
  return registerComponents([
    {
      name: "Repository",
      origin: ORIGIN,
      props: repositoryProps,
      fn: Repository,
    },
    {
      name: "Worktree",
      origin: ORIGIN,
      props: worktreeProps,
      fn: Worktree,
    },
    {
      name: "Dir",
      origin: ORIGIN,
      props: dirProps,
      fn: Dir,
    },
    {
      name: "Git.Switch",
      origin: ORIGIN,
      props: gitSwitchProps,
      fn: GitSwitch,
    },
    {
      name: "Git.Add",
      origin: ORIGIN,
      props: gitAddProps,
      fn: GitAdd,
    },
    {
      name: "Git.Commit",
      origin: ORIGIN,
      props: gitCommitProps,
      returns: gitCommitReturns,
      fn: GitCommit,
    },
  ]);
}

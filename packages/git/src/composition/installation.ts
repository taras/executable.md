/**
 * The sixteen repository-composition components, declared once for every host.
 *
 * Repository, Worktree, the four Git operations, the four Git reads,
 * PullRequest and its three evidence reads, IssueTracker and Issue are
 * ordinary registered defaults — not
 * reserved and not structural — so a repository-local component may shadow one
 * for its own scope. `<Dir>` is not among them: canonical core reserves that
 * name (`core/src/components/fixed-filesystem.ts`), and a document reaches it
 * with or without this package.
 *
 * ## One registry, and the policy an execution attaches underneath it
 *
 * Ten of the sixteen reach nothing beyond the selected checkout: Repository and
 * Worktree choose one, Git.Switch, Git.Add and Git.Commit change one, the four
 * Git reads observe one, and IssueTracker names a destination.
 *
 * The other six — `<Git.Push />`, `<PullRequest>`, its three evidence reads and
 * `<Issue>` — reach something no local transaction encloses. Each of those has
 * exactly one implementation, here, and it asks a semantic feature operation
 * for its work. How that operation is performed, retained and replayed is the
 * host's: an ordinary run and a workflow run forward to the public feature
 * Apis, a runtime with no provider keeps each Api's own refusing default, and a
 * REPL entry retains and reconciles beneath them.
 *
 * All sixteen are registered here, for every command that carries this
 * vocabulary, because this is what says the names exist: it is what `xmd
 * syntax` describes, what validation resolves against and what an execution
 * inherits. A host that retains one of these operations does not register a
 * different component for it — it declares this same body with its own policy
 * from inside its own execution's scope, where a nearer registration shadows a
 * farther one. Either way the component is the same: one body, one set of
 * forms, one return contract, because typing `<Issue>` means the same authored
 * operation wherever it is typed.
 *
 * Nothing here installs a provider, performs repository discovery, acquires a
 * lock or reaches a network: what a name *does* is the installed policy's, and
 * describing the environment selects none. Inspection and validation read the
 * declarations' metadata without calling a factory, which is what lets
 * `xmd syntax` and `<Plan>` describe this vocabulary.
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
import { Git } from "./git-api.ts";
import { IssueOperations } from "../issue/operations.ts";
import Repository, { props as repositoryProps } from "./components/Repository.ts";
import Worktree, { props as worktreeProps } from "./components/Worktree.ts";
import GitSwitch, { props as gitSwitchProps } from "./components/GitSwitch.ts";
import GitAdd, { props as gitAddProps } from "./components/GitAdd.ts";
import GitCommit, {
  props as gitCommitProps,
  returns as gitCommitReturns,
} from "./components/GitCommit.ts";
import { pushRegistration } from "./components/GitPush.ts";
import { pullRequestRegistration } from "./components/PullRequest.ts";
import {
  PULL_REQUEST_READ_KINDS,
  pullRequestReadRegistration,
} from "./components/PullRequestReads.ts";
import { issueRegistration } from "./components/Issue.ts";
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
 * Every name this boundary carries, in catalog order.
 *
 * Derived from the one registration array rather than listed again, so a
 * component added to it cannot disappear from the documentation this package
 * contributes or from an inventory held to it. An execution that declares one
 * of these operations with policy of its own declares it under this same name,
 * which is what makes one catalog true of every host.
 */
function compositionNames(): readonly string[] {
  return Object.freeze(COMPOSITION_REGISTRATIONS.map((registration) => registration.name));
}

/**
 * This boundary's long-form documentation, and the components it must cover.
 *
 * Derived from the registration array rather than listed again, so a component
 * added to it cannot be left undocumented here.
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
    compositionNames(),
    read,
  );
}

/** Repository and Worktree: which checkout the Markdown inside them expands in. */
const SELECTIONS: readonly ComponentRegistration[] = [
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
];

/**
 * What one selected checkout answers about itself, or changes inside itself.
 *
 * Git.Switch, Git.Add and Git.Commit change one and the four reads observe one;
 * either way a local transaction encloses the work, so none of them is an
 * operation a declaring execution names an invocation of.
 */
const LOCAL_OPERATIONS: readonly ComponentRegistration[] = [
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
];

/** The destination an `<Issue>` inside it is filed at. */
const TRACKER: ComponentRegistration = {
  name: "IssueTracker",
  origin: COMPOSITION_ORIGIN,
  props: issueTrackerProps,
  fn: IssueTracker,
  ...documented({
    description: `Select an issue tracker. \`<IssueTracker url={props.tracker}>…</IssueTracker>\` expands its content with the specified tracker in scope.`,
    as: null,
    context: "The Markdown whose issues are filed there.",
  }),
};

/**
 * The six operations no local transaction encloses, as ordinary registrations.
 *
 * The same bodies an owning execution declares, over the public feature Apis.
 * Registered, because this is where the names come from, and because an
 * ordinary default is what a nearer registration — a repository-local
 * component, an enclosing host, an execution that owns the operation — is
 * entitled to shadow.
 */
const EXTERNAL_OPERATIONS: readonly ComponentRegistration[] = [
  pushRegistration(Git.operations.push),
  pullRequestRegistration,
  ...PULL_REQUEST_READ_KINDS.map(pullRequestReadRegistration),
  issueRegistration(IssueOperations.operations),
];

/** All sixteen, in catalog order. */
export const COMPOSITION_REGISTRATIONS: readonly ComponentRegistration[] = Object.freeze([
  ...SELECTIONS,
  ...LOCAL_OPERATIONS,
  ...EXTERNAL_OPERATIONS,
  TRACKER,
]);

/**
 * Register the whole vocabulary as ordinary defaults for this scope.
 *
 * Every command that carries this vocabulary calls this, `repl` included: one
 * registry is what says which names exist, and an execution that owns one of
 * these operations attaches its policy to the same body from inside its own
 * scope rather than arriving with a vocabulary of its own.
 *
 * Every one of them is a declaration: this installs no provider, discovers no
 * ambient repository, acquires no lock, spawns no Git and reads no credential,
 * which is what lets `xmd syntax` enter it to describe the profile.
 */
export function* useCompositionComponents(): Operation<void> {
  yield* registerComponents(COMPOSITION_REGISTRATIONS);
  yield* contributeDocumentation(compositionDocumentation);
}

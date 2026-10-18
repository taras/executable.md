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
 * ## One implementation, two ways of carrying it
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
 * A host that retains nothing named after an invocation registers them
 * ordinarily, through {@link useCompositionComponents}, so a nearer
 * registration still shadows one. A host that does — a REPL entry — declares
 * the same six through {@link compositionDeclarations} with its own policy, and
 * registers the rest through {@link useCompositionSelections} so there is no
 * executable default for its declaration to shadow. Either way the component is
 * the same: one body, one set of forms, one return contract, because typing
 * `<Issue>` means the same authored operation wherever it is typed.
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
import type { IdentityComponent } from "@executablemd/core/host";
import { COMPOSITION_ORIGIN } from "./definitions.ts";
import { Git } from "./git-api.ts";
import type { GitApi } from "./git-api.ts";
import { IssueOperations } from "../issue/operations.ts";
import type { IssueOperationsApi } from "../issue/operations.ts";
import { PullRequestOperations } from "./pull-request-operations.ts";
import type { PullRequestOperationsApi } from "./pull-request-operations.ts";
import type { BindOperations, InvocationGate } from "./invocation-binding.ts";
import Repository, { props as repositoryProps } from "./components/Repository.ts";
import Worktree, { props as worktreeProps } from "./components/Worktree.ts";
import GitSwitch, { props as gitSwitchProps } from "./components/GitSwitch.ts";
import GitAdd, { props as gitAddProps } from "./components/GitAdd.ts";
import GitCommit, {
  props as gitCommitProps,
  returns as gitCommitReturns,
} from "./components/GitCommit.ts";
import { pushDeclaration, pushRegistration } from "./components/GitPush.ts";
import { pullRequestDeclaration, pullRequestRegistration } from "./components/PullRequest.ts";
import {
  PULL_REQUEST_READ_KINDS,
  pullRequestReadDeclaration,
  pullRequestReadRegistration,
} from "./components/PullRequestReads.ts";
import { issueDeclaration, issueRegistration } from "./components/Issue.ts";
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
 * How one host performs the six operations no local transaction encloses.
 *
 * One member per authored operation, each a constructor rather than an
 * operation: it is called with the site that authenticated one invocation, and
 * what it answers with is that invocation's own operations. Nothing a document,
 * a prop, a tracker, a Context value or middleware holds takes part in
 * selecting it — a host states its policy as direct code before any document
 * runs.
 *
 * The two pull-request members are separate because the policies are: an upsert
 * owns its delegated result and a read retains an admitted provider snapshot
 * beneath live transformations, and a host that shared one member between them
 * would be making those two policies equal.
 */
export interface CompositionPolicy {
  readonly push: BindOperations<GitApi["push"]>;
  readonly issue: BindOperations<IssueOperationsApi>;
  readonly pullRequest: BindOperations<PullRequestOperationsApi>;
  readonly pullRequestRead: BindOperations<PullRequestOperationsApi>;
}

/**
 * The operations an ordinary run, a workflow run and a provider-absent runtime
 * perform through.
 *
 * Each one is the public feature Api, so every handler a document, a plugin or
 * a host composed answers exactly as it did before any of this was declared —
 * and where nothing is installed, each Api's own default refuses. No site is
 * taken because none is authenticated: a profile that retains no
 * invocation-named work has nothing for a site to name, and inventing one would
 * be a name for work nobody is doing.
 */
const ORDINARY = {
  push:
    (gate: InvocationGate): GitApi["push"] =>
    (invocation) =>
      gate.once(() => Git.operations.push(invocation)),
  issue: (gate: InvocationGate): IssueOperationsApi => ({
    read: (invocation) => gate.once(() => IssueOperations.operations.read(invocation)),
    upsert: (invocation) => gate.once(() => IssueOperations.operations.upsert(invocation)),
  }),
  pullRequest: (gate: InvocationGate): PullRequestOperationsApi => ({
    read: (invocation) => gate.once(() => PullRequestOperations.operations.read(invocation)),
    upsert: (invocation) => gate.once(() => PullRequestOperations.operations.upsert(invocation)),
  }),
};

/**
 * That same wiring, as the policy a declaring host would supply.
 *
 * What a host declaring these operations gets where it retains none of them
 * itself: a REPL entry that records publications and issues still leaves
 * `<PullRequest>` and its reads their own unchanged missing-provider refusal,
 * and a runtime with no provider at all declares every one of them this way.
 */
export function ordinaryCompositionPolicy(): CompositionPolicy {
  return {
    push: (_site, gate) => ORDINARY.push(gate),
    issue: (_site, gate) => ORDINARY.issue(gate),
    pullRequest: (_site, gate) => ORDINARY.pullRequest(gate),
    pullRequestRead: (_site, gate) => ORDINARY.pullRequest(gate),
  };
}

/**
 * The six declarations whose implementations name their own durable work.
 *
 * Built in one place, from one policy, so an ordinary run, a workflow run, a
 * REPL entry, a provider-absent runtime and a descriptive command all declare
 * the same names, origins, props, forms, return contracts and prose. A host
 * that wanted a different implementation would have to supply a different
 * policy, which is the only thing a host is allowed to differ on.
 */
export function compositionDeclarations(policy: CompositionPolicy): readonly IdentityComponent[] {
  return Object.freeze([
    pushDeclaration(policy.push),
    pullRequestDeclaration(policy.pullRequest),
    ...PULL_REQUEST_READ_KINDS.map((kind) =>
      pullRequestReadDeclaration(kind, policy.pullRequestRead),
    ),
    issueDeclaration(policy.issue),
  ]);
}

/**
 * Every name this boundary carries, in catalog order.
 *
 * Derived from the one registration array rather than listed again, so a
 * component added to it cannot disappear from the documentation this package
 * contributes or from an inventory held to it. The declaring path carries the
 * same six operations under the same names, which is what makes one catalog
 * true of both.
 */
export function compositionNames(): readonly string[] {
  return Object.freeze(COMPOSITION_REGISTRATIONS.map((registration) => registration.name));
}

/**
 * This boundary's long-form documentation, and the components it must cover.
 *
 * Derived from the two declaration paths rather than listed again, so a
 * component added to either cannot be left undocumented here.
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
 * The same bodies the declaring path carries, over the public feature Apis.
 * Registered rather than declared, because a host that retains nothing named
 * after an invocation has no identity for one to name — and because these stay
 * ordinary defaults a nearer registration shadows.
 */
const EXTERNAL_OPERATIONS: readonly ComponentRegistration[] = [
  pushRegistration(ORDINARY.push),
  pullRequestRegistration(ORDINARY.pullRequest),
  ...PULL_REQUEST_READ_KINDS.map((kind) => pullRequestReadRegistration(kind, ORDINARY.pullRequest)),
  issueRegistration(ORDINARY.issue),
];

/**
 * The selection, local-operation and tracker half: everything a host that
 * installs its own policy under the six operations still registers ordinarily.
 */
export const SELECTION_REGISTRATIONS: readonly ComponentRegistration[] = Object.freeze([
  ...SELECTIONS,
  ...LOCAL_OPERATIONS,
  TRACKER,
]);

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
 * Every one of them is a declaration: this installs no provider, discovers no
 * ambient repository, acquires no lock, spawns no Git and reads no credential,
 * which is what lets `xmd syntax` enter it to describe the profile.
 */
export function* useCompositionComponents(): Operation<void> {
  yield* registerComponents(COMPOSITION_REGISTRATIONS);
  yield* contributeDocumentation(compositionDocumentation);
}

/**
 * Register everything except the six operations, for a command whose
 * executions install their own policy under them.
 *
 * A REPL entry declares those six through {@link compositionDeclarations} with
 * the policy it retains them under, so registering an executable default here
 * would be registering a body for the entry's declaration to shadow. The
 * documentation still describes all sixteen: it is the same vocabulary either
 * way, and a reader asking about `<Issue>` is asking about one component.
 */
export function* useCompositionSelections(): Operation<void> {
  yield* registerComponents(SELECTION_REGISTRATIONS);
  yield* contributeDocumentation(compositionDocumentation);
}

/**
 * What an ordinary run does to a checkout, and what it remembers about it.
 *
 * The three local operations are the workflow provider's own performers, run
 * against a real directory instead of an exported materialization. That is
 * deliberate reuse rather than a parallel implementation: `<Git.Switch>` refuses
 * a branch another checkout holds, `<Git.Add>` stages exactly the pathspecs a
 * document wrote, and `<Git.Commit>` records the index and nothing else — and
 * those are the authored semantics, not a workflow detail.
 *
 * What is different is everything around them. There is no Workspace
 * transaction to enclose a person's own repository in, so a failure rolls back
 * nothing and this makes no such claim; there is no journal, so nothing is
 * retained and nothing replays; and the commit lands in the checkout the person
 * is standing in rather than in a root the run owns.
 *
 * ## Push, and the evidence it leaves
 *
 * Push keeps the shared observe/adopt/fast-forward/refuse rules exactly. What
 * it does *not* keep is the Git-host reconciliation record, because there is no
 * history to reconcile against. Instead a verified publication leaves one entry
 * in this provider instance's own closure, and that entry is the only thing
 * that authorizes a later `<PullRequest>`.
 *
 * The entry is not a Context value, a component result, a middleware answer or
 * a journal event. It cannot be copied into another execution, because another
 * execution constructs a new provider with an empty list — which is what makes
 * "this run published that branch" mean this run.
 */

import type { Operation } from "effection";
import {
  GitOperationAuthorityError,
  GitOperationInfrastructureError,
} from "../../composition/errors.ts";
import type {
  GitAddResult,
  GitCheckoutIdentity,
  GitCheckoutState,
  GitCommitMessageSource,
  GitCommitResult,
  GitSwitchResult,
} from "../../composition/git-records.ts";
import {
  ANCESTOR,
  destinationRefFor,
  PUSH_REMOTE,
  refspecFor,
  type GitPushInputs,
  type GitPushOutcome,
  type GitPushPreState,
} from "../../composition/git-push-records.ts";
import { beneath } from "../../composition/parse.ts";
import { sameRepositoryIdentity, type RepositoryIdentity } from "../../composition/selection.ts";
import {
  GitHostAmbiguousError,
  GitHostConflictError,
  GitHostUnavailableError,
} from "../../git-host/errors.ts";
import { ADD } from "../../composition/components/GitAdd.ts";
import { COMMIT } from "../../composition/components/GitCommit.ts";
import { PUSH } from "../../composition/components/GitPush.ts";
import { SWITCH } from "../../composition/components/GitSwitch.ts";
import {
  addPaths,
  commitPresent,
  currentBranch,
  observeRemoteRef,
  pushRefspec,
  resolveCommit,
} from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import { checkoutState, type GitCheckout } from "../composition/operations.ts";
import { performSwitch } from "../composition/switch.ts";
import { gitCommitMessageEvidence, performCommit } from "../composition/commit.ts";
import {
  useGitAuthentication,
  type GitCommitIdentity,
  type RepositoryHost,
} from "../composition/host.ts";
import { gitRefused } from "../composition/refusals.ts";
import { LivePushEvidenceError, UnresolvedGitIdentityError } from "./errors.ts";

/**
 * One checkout this execution may act in.
 *
 * Registered when a Repository or Worktree is selected, and the ambient one
 * when there is one. `identity` is the *repository's*, so every checkout of one
 * repository carries the same identity and a working directory selects among
 * them by path.
 */
export interface RegisteredCheckout {
  /** The canonical host path of the checkout root. */
  readonly root: string;
  readonly identity: RepositoryIdentity;
  /** The Repository's display name, as a document wrote it or the host found it. */
  readonly repositoryName: string;
  /** The Worktree's name, or `null` for a repository's own checkout. */
  readonly worktreeName: string | null;
  /** The admitted origin this checkout publishes to, when it has one. */
  readonly origin: string | undefined;
}

/** What one verified publication proved, held in the provider's closure. */
export interface PushEvidence {
  readonly identity: RepositoryIdentity;
  readonly checkoutRoot: string;
  readonly origin: string;
  readonly branch: string;
  readonly destinationRef: string;
  readonly commit: string;
}

/**
 * Which registered checkout this repository and working directory select.
 *
 * The same two observations a workflow operation makes, decided the same way:
 * the repository says which checkouts are candidates, and the working directory
 * says which of them the element was written in. The longest match wins, so a
 * `<Dir>` inside a linked worktree selects the worktree rather than the
 * repository it belongs to.
 *
 * ## A candidate is a candidate only under the whole identity
 *
 * "The repository" means every member of the identity, compared by
 * `sameRepositoryIdentity`. A locator fingerprint alone names *where a
 * repository came from*, and two Repositories selected from one locator under
 * different names are different repositories with separate leases, separate
 * placements and separate Push evidence. Admitting on the fingerprint would let
 * a `<Dir>` into the second one carry the first one's authority — the element
 * would be authenticated against the Repository in scope and then act in a
 * checkout that Repository never selected.
 *
 * Every checkout of one repository still carries that repository's identity —
 * a Worktree registers under its owner's — so requiring the whole identity
 * narrows nothing a document can legitimately reach.
 */
export function selectCheckout(
  registered: readonly RegisteredCheckout[],
  identity: RepositoryIdentity,
  workingDirectory: string,
  operation: string,
): RegisteredCheckout {
  let selected: RegisteredCheckout | undefined;
  for (const candidate of registered) {
    if (!sameRepositoryIdentity(candidate.identity, identity)) {
      continue;
    }
    if (!beneath(candidate.root, workingDirectory)) {
      continue;
    }
    if (selected === undefined || candidate.root.length > selected.root.length) {
      selected = candidate;
    }
  }
  if (selected === undefined) {
    throw new GitOperationAuthorityError(
      operation,
      "the directory it was written in is inside none of the checkouts this execution selected " +
        "for the repository in scope",
    );
  }
  return selected;
}

/** The `GitCheckout` the shared performers act on, for a live directory. */
export function liveCheckout(
  git: GitSession,
  checkout: RegisteredCheckout,
  workingDirectory: string,
): GitCheckout {
  const identity: GitCheckoutIdentity = Object.freeze({
    repositoryName: checkout.repositoryName,
    worktreeName: checkout.worktreeName,
    checkoutPath: checkout.root,
  });
  return {
    git,
    directory: checkout.root,
    repositoryDirectory: checkout.root,
    workingDirectory,
    identity,
  };
}

export function* liveSwitch(
  checkout: GitCheckout,
  branch: string,
  base: string | undefined,
): Operation<GitSwitchResult> {
  const before = yield* checkoutState(checkout.git, checkout.directory, SWITCH);
  const performed = yield* performSwitch(checkout, branch, base);
  const after = yield* checkoutState(checkout.git, checkout.directory, SWITCH);
  return Object.freeze({
    checkout: checkout.identity,
    requestedBranch: branch,
    resolvedBranch: after.branch,
    requestedBase: base ?? null,
    resolvedBase: performed.resolvedBase,
    before,
    after,
  });
}

export function* liveAdd(checkout: GitCheckout, paths: readonly string[]): Operation<GitAddResult> {
  const before = yield* checkoutState(checkout.git, checkout.directory, ADD);
  yield* addPaths(checkout.git, {
    operation: ADD,
    workingDirectory: checkout.workingDirectory,
    paths,
  });
  const after = yield* checkoutState(checkout.git, checkout.directory, ADD);
  return Object.freeze({ checkout: checkout.identity, paths, before, after });
}

export function* liveCommit(
  checkout: GitCheckout,
  message: string,
  messageSource: GitCommitMessageSource,
  identity: GitCommitIdentity | undefined,
): Operation<GitCommitResult> {
  // Before the index is read and long before an object is written: a host that
  // cannot say who a commit is by cannot make one, and saying so first means
  // nothing was staged, moved or written for a commit that was never going to
  // exist.
  if (identity === undefined) {
    throw new UnresolvedGitIdentityError();
  }
  const evidence = gitCommitMessageEvidence(message);
  const before: GitCheckoutState = yield* checkoutState(checkout.git, checkout.directory, COMMIT);
  const performed = yield* performCommit(checkout, before, message, evidence, identity);
  const after = yield* checkoutState(checkout.git, checkout.directory, COMMIT);
  return Object.freeze({
    checkout: checkout.identity,
    messageSource,
    messageDigest: evidence.digest,
    messageLength: evidence.length,
    parent: performed.parent,
    tree: performed.tree,
    commit: performed.commit,
    committedAt: performed.committedAt,
    before,
    after,
  });
}

/** Whether the observed commit is somewhere in the source commit's ancestry. */
function* provenAncestor(
  git: GitSession,
  directory: string,
  observed: string,
  desired: string,
): Operation<boolean> {
  if (!(yield* commitPresent(git, directory, observed))) {
    return false;
  }
  const outcome = yield* git.run(["merge-base", "--is-ancestor", observed, desired], directory);
  if (outcome.code === 0) {
    return true;
  }
  if (outcome.code === 1) {
    return false;
  }
  throw new GitOperationInfrastructureError(
    PUSH,
    "native Git could not decide whether the branch already holds an earlier commit",
  );
}

/**
 * Publish this checkout's current branch, and say what happened.
 *
 * The same rules the reconciled effect follows, minus the reconciliation. A
 * destination that already names this exact commit is adopted rather than
 * pushed again; a proven-absent one, and one holding an ancestor of this
 * commit, are published once with an exact non-force refspec; anything else is
 * a conflict. A host that could not answer proves nothing and is never read as
 * absence.
 */
export function* livePush(
  host: RepositoryHost,
  git: GitSession,
  checkout: RegisteredCheckout,
): Operation<{ outcome: GitPushOutcome; evidence: PushEvidence }> {
  if (checkout.origin === undefined) {
    throw new GitOperationAuthorityError(
      PUSH,
      "the checkout it selected records no usable origin, so there is nowhere for this branch " +
        "to be published to. No credential was read and nothing was contacted",
    );
  }
  const branch = yield* currentBranch(git, checkout.root);
  if (branch === undefined) {
    gitRefused(PUSH, "unnamed-branch");
  }
  const sourceCommit = yield* resolveCommit(git, checkout.root, "HEAD");
  if (sourceCommit === undefined) {
    throw new GitOperationInfrastructureError(
      PUSH,
      "the checkout it ran in did not report the commit its branch holds",
    );
  }
  const destinationRef = destinationRefFor(branch);
  const inputs: GitPushInputs = Object.freeze({
    repository: checkout.identity,
    remote: PUSH_REMOTE,
    branch,
    destinationRef,
    sourceCommit,
  });

  // One session for this publication, opened after the local checks above and
  // released with the scope this operation runs in.
  const session = yield* useGitAuthentication(host, checkout.origin);
  const observed = yield* observeRemoteRef(
    git,
    checkout.root,
    checkout.origin,
    destinationRef,
    checkout.identity.objectFormat,
    session,
  );
  if (observed.state === "unreachable") {
    // Not absence. A host that could not answer has proven nothing, and
    // offering silence as absence is what would authorize a duplicate push.
    throw new GitHostUnavailableError();
  }
  if (observed.state === "ambiguous") {
    throw new GitHostAmbiguousError();
  }

  const evidence: PushEvidence = Object.freeze({
    identity: checkout.identity,
    checkoutRoot: checkout.root,
    origin: checkout.origin,
    branch,
    destinationRef,
    commit: sourceCommit,
  });

  if (observed.state === "present" && observed.commit === sourceCommit) {
    return {
      outcome: {
        decision: "adopted",
        result: resultOf(inputs, observed.commit),
      },
      evidence,
    };
  }

  const preState: GitPushPreState =
    observed.state === "absent"
      ? { remoteCommit: null }
      : (yield* provenAncestor(git, checkout.root, observed.commit, sourceCommit))
        ? { remoteCommit: observed.commit, relation: ANCESTOR }
        : { remoteCommit: observed.commit };
  if (preState.remoteCommit !== null && !("relation" in preState)) {
    // The destination names a commit this branch does not contain. Publishing
    // over it would replace somebody's work rather than advance the branch.
    throw new GitHostConflictError();
  }

  const accepted = yield* pushRefspec(
    git,
    checkout.root,
    checkout.origin,
    refspecFor(sourceCommit, destinationRef),
    session,
  );
  if (!accepted) {
    throw new GitHostUnavailableError();
  }
  // One exact observation afterwards decides the outcome, never the status of
  // the command: what a push left at the destination is a question about the
  // destination.
  const settled = yield* observeRemoteRef(
    git,
    checkout.root,
    checkout.origin,
    destinationRef,
    checkout.identity.objectFormat,
    session,
  );
  if (settled.state !== "present" || settled.commit !== sourceCommit) {
    throw new GitHostUnavailableError();
  }
  return {
    outcome: { decision: "performed", result: resultOf(inputs, settled.commit) },
    evidence,
  };
}

function resultOf(inputs: GitPushInputs, observedRemoteCommit: string) {
  return Object.freeze({
    repository: inputs.repository,
    remote: inputs.remote,
    branch: inputs.branch,
    destinationRef: inputs.destinationRef,
    refspec: refspecFor(inputs.sourceCommit, inputs.destinationRef),
    sourceCommit: inputs.sourceCommit,
    observedRemoteCommit,
  });
}

/**
 * That this execution published the branch a pull request would name.
 *
 * Every member has to match, and the *last* entry for a destination is the one
 * that decides: a loop that commits, pushes, commits and pushes again leaves a
 * sequence, and what a pull request is opened against is where that sequence
 * ended. A push of another checkout, repository, origin, destination, branch or
 * commit is irrelevant rather than disagreement.
 */
export function admitLivePushEvidence(
  held: readonly PushEvidence[],
  expected: Omit<PushEvidence, "commit"> & { readonly commit: string },
): void {
  let published: "this head" | "another commit" | undefined;
  for (const entry of held) {
    if (
      entry.identity.locatorFingerprint !== expected.identity.locatorFingerprint ||
      entry.checkoutRoot !== expected.checkoutRoot ||
      entry.origin !== expected.origin ||
      entry.branch !== expected.branch ||
      entry.destinationRef !== expected.destinationRef
    ) {
      continue;
    }
    published = entry.commit === expected.commit ? "this head" : "another commit";
  }
  if (published === "this head") {
    return;
  }
  if (published === undefined) {
    throw new LivePushEvidenceError(
      "missing-push-evidence",
      "this execution holds no successful <Git.Push> result for the branch and commit it would " +
        "open a pull request from. Write <Git.Push /> before <PullRequest>: a pull request names " +
        "work this execution published, and publishing it is an explicit act.",
    );
  }
  throw new LivePushEvidenceError(
    "conflicting-push-evidence",
    "this execution published that branch at a different commit than the one the checkout is on " +
      "now, so a pull request opened from it would name a head this execution never published.",
  );
}

export type { GitCheckout };

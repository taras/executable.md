/**
 * What `<Git.Switch>` owns: one branch change, and the evidence it happened.
 *
 * Everything about *where* it happens belongs to the operation envelope. What is
 * here is the branch decision itself, which is one question asked in one order:
 * does the branch already exist, locally or on the repository's remote? An
 * existing branch is switched to and its base is not consulted, because a base
 * is what a branch is created from and this one was not created here. A missing
 * branch is created from the supplied base, or from where the checkout already
 * is when there is none — never from a remote asked again.
 *
 * The retained result keeps both halves of that: what the document asked for,
 * and the commit the branch actually started from. `null` in `resolvedBase` is
 * itself the evidence that the branch already existed.
 */
import { type Operation } from "effection";
import { getExpansion, sourceDescription } from "@executablemd/core";
import type { EffectDescription, Json } from "@executablemd/durable-streams";
import { GitOperationProtocolError } from "../../composition/errors.ts";
import {
  gitSwitchResultJson,
  parseGitSwitchResult,
  type GitCheckoutState,
  type GitSwitchRequest,
  type GitSwitchResult,
} from "../../composition/git-records.ts";
import { SWITCH } from "../../composition/components/GitSwitch.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { branchExists, resolveBaseCommit, resolveCommit, switchBranch } from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import {
  fingerprintOf,
  settled,
  type CompositionOutcome,
  type MutationContext,
} from "./effects.ts";
import { gitRefused } from "./refusals.ts";
import { performGitOperation, type GitCheckout } from "./operations.ts";

/** The effect type one branch change is recorded under. */
export const WORKSPACE_GIT_SWITCH = "workspace_git_switch";

/**
 * How one switch is identified.
 *
 * The expansion makes two elements different effects and one element the same
 * effect across replays; the configuration fingerprint makes a document edited
 * to name another branch, base or checkout diverge rather than replaying the
 * previous one's retained result. Durable identity is type and name, so the
 * fingerprint belongs in the name rather than beside it.
 */
export function* describeSwitch(request: GitSwitchRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  // The whole observation, not only what it asked for. The record a document was
  // written against is part of what this effect is: replaying a result recorded
  // for one Repository under an observation naming another would hand back a
  // transition that never described this invocation.
  const configuration = fingerprintOf([
    request.repository.name,
    request.repository.locatorFingerprint,
    request.repository.requestedBase,
    request.repository.creationCommit,
    request.repository.primaryBranch,
    request.repository.objectFormat,
    request.repository.checkoutPath,
    request.workingDirectory,
    request.branch,
    request.base ?? null,
  ]);
  return {
    type: WORKSPACE_GIT_SWITCH,
    name: `${expansion.id}:${request.repository.name}:${configuration}`,
    configuration,
    ...sourceDescription(expansion.position),
  };
}

interface Switched {
  readonly resolvedBase: string | null;
}

function* performSwitch(
  checkout: GitCheckout,
  branch: string,
  base: string | undefined,
): Operation<Switched> {
  // A branch whose name reads as an option would be one to Git, whatever the
  // separator after it says.
  if (branch.startsWith("-")) {
    gitRefused(SWITCH, "invalid-branch");
  }

  // Git runs where the element was written; what it answers about is the
  // checkout that directory belongs to.
  const { git, workingDirectory, directory } = checkout;
  if (yield* branchExists(git, directory, branch)) {
    yield* switchBranch(git, {
      operation: SWITCH,
      workingDirectory,
      checkout: directory,
      branch,
      start: undefined,
    });
    return { resolvedBase: null };
  }

  const start =
    base === undefined
      ? yield* resolveCommit(git, directory, "HEAD")
      : yield* resolveBaseCommit(git, directory, base);
  if (start === undefined) {
    gitRefused(SWITCH, "unresolved-base");
  }
  yield* switchBranch(git, {
    operation: SWITCH,
    workingDirectory,
    checkout: directory,
    branch,
    start,
  });
  return { resolvedBase: start };
}

export function performGitSwitch(
  context: MutationContext,
  host: RepositoryHost,
  request: GitSwitchRequest,
): Operation<CompositionOutcome> {
  return performGitOperation(
    context,
    host,
    SWITCH,
    { repository: request.repository, workingDirectory: request.workingDirectory },
    (checkout) => performSwitch(checkout, request.branch, request.base),
    (checkout, before: GitCheckoutState, after: GitCheckoutState, performed: Switched): Json =>
      gitSwitchResultJson({
        checkout: checkout.identity,
        requestedBranch: request.branch,
        resolvedBranch: after.branch,
        requestedBase: request.base ?? null,
        resolvedBase: performed.resolvedBase,
        before,
        after,
      }),
  );
}

/** The whole of what `<Git.Switch>` asks for: one durable effect, exactly parsed. */
export function* createGitSwitch(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: GitSwitchRequest,
): Operation<GitSwitchResult> {
  const outcome = yield* settled(
    "git",
    SWITCH,
    database,
    yield* describeSwitch(request),
    (filesystem, metadata) => performGitSwitch({ filesystem, metadata }, host, request),
  );
  // Read for this request rather than merely read: a result that does not
  // describe the checkout, branch, base and transition this invocation asked for
  // is not this invocation's result, whatever else it is.
  const result = parseGitSwitchResult(outcome, request);
  if (result === undefined) {
    throw new GitOperationProtocolError(SWITCH);
  }
  return result;
}

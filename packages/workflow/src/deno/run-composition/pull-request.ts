/**
 * `<PullRequest>` under an ordinary run: the same reconciliation, no history.
 *
 * A workflow run reconciles a pull request through the shared Git-host state
 * machine, which exists so that an interrupted attempt is adopted on the next
 * *execution of the same run*. An ordinary run has no next execution: a second
 * `xmd run` is a second question, not a resumption. So the state machine's
 * durability has nothing to be durable about, and what is left is the part that
 * was always about GitHub — observe once, adopt what already says this, create
 * or update once, and decide by one exact observation afterwards.
 *
 * That part is not reimplemented here. `gitHubPullRequests()` is the same
 * adapter the workflow provider drives, with the same filtered listing, the same
 * refusal of an unreadable candidate, and the same normalization; what this
 * module owns is the ordering above it.
 *
 * ## Interruption, said plainly
 *
 * Inside one execution an attempt is made at most once. Across a process
 * interruption there is no exactly-once claim at all: GitHub may have accepted a
 * change for which this run recorded no result, and the next run observes what
 * is there and decides from that. Nothing pretends otherwise, and nothing is
 * retained that would let it.
 */

import type { Operation } from "effection";
import { GitOperationInfrastructureError } from "../../composition/errors.ts";
import { PULL_REQUEST_ELEMENT } from "../../composition/components/PullRequest.ts";
import {
  pullRequestAgrees,
  pullRequestResultOf,
  type PullRequestInputs,
  type PullRequestResult,
  type PullRequestSnapshot,
} from "../../composition/pull-request-records.ts";
import {
  GitHostAmbiguousError,
  GitHostConflictError,
  GitHostUnavailableError,
} from "../../git-host/errors.ts";
import { GitHostProviderError } from "../../git-host/errors.ts";
import { gitHubPullRequests, parseGitHubRepository } from "../composition/github.ts";
import type { GitHubAccess } from "../composition/github.ts";

function unusable(reason: string): never {
  throw new GitOperationInfrastructureError(PULL_REQUEST_ELEMENT, reason);
}

/**
 * Bring exactly one pull request to what this invocation says, once.
 *
 * The caller has already proved that this execution published the head branch;
 * everything here is about the pull request itself.
 */
export function* liveUpsertPullRequest(
  access: GitHubAccess,
  locator: string,
  inputs: PullRequestInputs,
): Operation<PullRequestResult> {
  const name = parseGitHubRepository(locator);
  if (name === undefined) {
    throw new GitHostProviderError(
      "this Git host adapter opens pull requests only for repositories on github.com",
    );
  }
  const pulls = gitHubPullRequests(access, name, inputs.repository.objectFormat);

  const observed = yield* pulls.observe(inputs);
  if (observed.state === "unavailable") {
    // Not absence. A host that could not answer has proven nothing, and
    // offering silence as absence is what would open a second pull request or
    // rewrite one this invocation never saw.
    throw new GitHostUnavailableError();
  }
  if (observed.state === "ambiguous") {
    throw new GitHostAmbiguousError();
  }
  if (observed.state === "conflict") {
    throw new GitHostConflictError();
  }
  if (observed.state === "absent") {
    // Only an unnumbered request can reach this: a number that named nothing
    // provable is unavailable rather than absent, above.
    if (inputs.number !== null) {
      unusable("a numbered pull request cannot be created");
    }
    return yield* created(pulls, inputs);
  }

  const found = observed.pullRequest;
  if (pullRequestAgrees(found, inputs)) {
    // Everything this invocation asks for is already true — the no-op an
    // unchanged document means, and the adoption an interrupted earlier attempt
    // leaves behind.
    return pullRequestResultOf(inputs, found);
  }
  if (inputs.number === null) {
    // One open pull request for this branch pair, saying something else. An
    // unnumbered request asks for one to exist, not for whatever is there to
    // become this.
    throw new GitHostConflictError();
  }
  if (found.number !== inputs.number) {
    unusable("the pull request this attempt would update is not the one it observed");
  }
  return yield* updated(pulls, inputs, found);
}

type Adapter = ReturnType<typeof gitHubPullRequests>;

/** One creation, and one observation if its outcome is uncertain. */
function* created(pulls: Adapter, inputs: PullRequestInputs): Operation<PullRequestResult> {
  const attempt = yield* pulls.create(inputs);
  if (attempt.state === "settled") {
    if (!pullRequestAgrees(attempt.pullRequest, inputs)) {
      unusable("the Git host created a pull request other than the one it was asked for");
    }
    return pullRequestResultOf(inputs, attempt.pullRequest);
  }
  if (attempt.state === "unreadable") {
    unusable("the Git host answered the creation with something this boundary cannot read");
  }

  // A race, a rejection or a failure with no word for it: what happened is
  // decided by observing once, never by a second attempt to create.
  const observed = yield* pulls.observe(inputs);
  if (observed.state === "found" && pullRequestAgrees(observed.pullRequest, inputs)) {
    return pullRequestResultOf(inputs, observed.pullRequest);
  }
  throw new GitHostUnavailableError();
}

/** The required mutations, once each, and the one observation that decides. */
function* updated(
  pulls: Adapter,
  inputs: PullRequestInputs,
  before: PullRequestSnapshot,
): Operation<PullRequestResult> {
  const attempt = yield* pulls.update(inputs, before);
  if (attempt.state === "unreadable") {
    unusable("the Git host answered the update with something this boundary cannot read");
  }
  if (attempt.state === "uncertain" || !pullRequestAgrees(attempt.pullRequest, inputs)) {
    // A rejected mutation, a partial multi-call update and a host that could
    // not be read afterwards are one answer: this attempt did not reach the
    // requested state. Nothing is repeated here.
    throw new GitHostUnavailableError();
  }
  if (attempt.pullRequest.number !== before.number) {
    unusable("the Git host answered with a pull request other than the one being updated");
  }
  return pullRequestResultOf(inputs, attempt.pullRequest);
}

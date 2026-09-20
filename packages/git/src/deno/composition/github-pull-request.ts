/**
 * The GitHub adapter for one pull-request reconciliation.
 *
 * Everything reaching GitHub for `<PullRequest>` and nothing else. It is handed
 * what the orchestration above it has already established — the authenticated
 * locator, the admitted inputs, and an access session — and it never sees where
 * any of that came from. No Workspace, no run database, no journal and no
 * callback onto one of them crosses this boundary: by the time a provider
 * exists, the run's own record of publishing the branch has already admitted
 * the request, and what is left is a conversation with a service.
 *
 * That is what keeps the provider-neutral half neutral. A Git host is selected
 * from the locator this invocation carries, so an unsupported one is refused
 * here — before a credential is read and before anything is sent.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { GitOperationInfrastructureError } from "../../composition/errors.ts";
import { PULL_REQUEST_ELEMENT } from "../../composition/components/PullRequest.ts";
import {
  parsePullRequestInputs,
  parsePullRequestPreState,
  PULL_REQUEST,
  pullRequestAgrees,
  pullRequestObservationsJson,
  pullRequestPreStateJson,
  pullRequestResultJson,
  pullRequestResultOf,
  samePullRequestIdentity,
  type PullRequestInputs,
  type PullRequestSnapshot,
} from "../../composition/pull-request-records.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import { GitHostProviderError, GitHostUnavailableError } from "../../git-host/errors.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostObservation,
} from "../../git-host/records.ts";
import { sameRepositoryIdentity } from "../../composition/selection.ts";
import { gitHubPullRequests, parseGitHubRepository, type GitHubAccess } from "./github.ts";

function unusable(reason: string): never {
  throw new GitOperationInfrastructureError(PULL_REQUEST_ELEMENT, reason);
}

/**
 * A pre-state that claims nothing.
 *
 * The three refusing observations publish no record — the engine journals a
 * conflict, an ambiguity and an unavailability as the effect's failed result
 * and discards everything the observation carried — so what a refusal saw at
 * the Git host has no reason to be described. A pull request somebody else
 * opened is their text, and this is the boundary that exists to keep it there.
 */
const NOTHING_PROVEN = pullRequestPreStateJson({ pullRequest: null });

/**
 * The provider that answers this exact reconciliation, and no other.
 *
 * Installed around one `reconcileGitHostEffect()` call and reachable only from
 * inside it. Its closure holds the parsed repository name, the endpoint and the
 * credential source; what it receives from the engine is the frozen request,
 * which it parses and holds to the inputs this invocation admitted. A request
 * naming another Repository, another branch pair or other content is not this
 * invocation's, and answering one would publish a completion for something this
 * operation never admitted.
 */
export function pullRequestProvider(
  access: GitHubAccess,
  locator: string,
  admitted: PullRequestInputs,
): GitHostProvider {
  function admit(request: CompleteGitHostEffectRequest): PullRequestInputs {
    const inputs = parsePullRequestInputs(request.inputs);
    if (
      request.kind !== PULL_REQUEST ||
      inputs === undefined ||
      !sameRepositoryIdentity(inputs.repository, admitted.repository) ||
      inputs.title !== admitted.title ||
      inputs.body !== admitted.body ||
      inputs.draft !== admitted.draft ||
      inputs.headBranch !== admitted.headBranch ||
      inputs.headSha !== admitted.headSha ||
      inputs.baseBranch !== admitted.baseBranch ||
      inputs.number !== admitted.number
    ) {
      unusable(
        "the Git host asked this provider about a pull request this invocation did not describe",
      );
    }
    return inputs;
  }

  /** The adapter for this Repository, or a refusal of the whole effect kind. */
  function adapter(): ReturnType<typeof gitHubPullRequests> | undefined {
    const name = parseGitHubRepository(locator);
    return name === undefined
      ? undefined
      : gitHubPullRequests(access, name, admitted.repository.objectFormat);
  }

  function completion(pullRequest: PullRequestSnapshot): GitHostCompletion {
    return {
      observations: pullRequestObservationsJson({ pullRequest }),
      result: pullRequestResultJson(pullRequestResultOf(admitted, pullRequest)),
    };
  }

  return {
    *observe(request): Operation<Result<GitHostObservation>> {
      const inputs = admit(request);
      const pulls = adapter();
      if (pulls === undefined) {
        // Said from observation and before any remote work, which is exactly
        // how §10.2 has a host decline a kind it does not implement. The
        // locator itself is not repeated: what this run holds for it is a
        // fingerprint, and that is what a reader has.
        return Err(
          new GitHostProviderError(
            "this Git host adapter opens pull requests only for repositories on github.com",
          ),
        );
      }

      const observed = yield* pulls.observe(inputs);
      if (observed.state === "unavailable") {
        // Not absence. A host that could not answer has proven nothing, and
        // offering silence as absence is what would open a second pull request
        // or rewrite one this invocation never saw.
        return Err(new GitHostUnavailableError());
      }
      if (observed.state === "ambiguous") {
        return Ok({ state: "ambiguous", preState: NOTHING_PROVEN });
      }
      if (observed.state === "conflict") {
        return Ok({ state: "conflict", preState: NOTHING_PROVEN });
      }
      if (observed.state === "absent") {
        // Only an unnumbered request can reach this: a number that named
        // nothing provable is unavailable rather than absent, above.
        return Ok({ state: "absent", preState: NOTHING_PROVEN });
      }

      const found = observed.pullRequest;
      if (pullRequestAgrees(found, inputs)) {
        // Everything this invocation asks for is already true. For an
        // unnumbered request that is the pull request an interrupted attempt
        // created; for a numbered one it is the no-op an unchanged document
        // means. Both are the shared adoption, with the pre-state and the
        // observations one reading of one pull request.
        const adopted = completion(found);
        return Ok({
          state: "compatible",
          preState: pullRequestPreStateJson({ pullRequest: found }),
          observations: adopted.observations,
          result: adopted.result,
        });
      }

      if (inputs.number === null) {
        // One open pull request for this branch pair, saying something else.
        // An unnumbered request asks for one to exist, not for whatever is
        // there to become this — rewriting it would act on a pull request the
        // document never named.
        return Ok({ state: "conflict", preState: NOTHING_PROVEN });
      }

      // The document named this pull request and asked for fields it does not
      // hold. Absent is the shared machine's word for "the requested
      // completion is not there", and the pre-state is what is there instead —
      // which is how a performed update can describe what it acted on.
      return Ok({
        state: "absent",
        preState: pullRequestPreStateJson({ pullRequest: found }),
      });
    },

    *perform(request, observation): Operation<Result<GitHostCompletion>> {
      const inputs = admit(request);
      const pulls = adapter();
      if (pulls === undefined) {
        unusable("the Git host that proved absence is not the one being asked to act");
      }

      // Which of the two this is, is decided by the proven absence itself. The
      // engine reaches `perform` only from `absent`, and the pre-state it
      // carries is this attempt's own observation: nothing there, or the pull
      // request the document named as it stood a moment ago.
      const before = parsePullRequestPreState(observation.preState, inputs.repository.objectFormat);
      if (before === undefined) {
        unusable("the proven absence this attempt acts on describes no pre-state");
      }
      if (before.pullRequest === null) {
        if (inputs.number !== null) {
          unusable("a numbered pull request cannot be created");
        }
        return yield* created(pulls, inputs);
      }
      if (inputs.number === null || before.pullRequest.number !== inputs.number) {
        unusable("the pull request this attempt would update is not the one it observed");
      }
      return yield* updated(pulls, inputs, before.pullRequest);
    },
  };

  /** One creation, and one observation if its outcome is uncertain. */
  function* created(
    pulls: ReturnType<typeof gitHubPullRequests>,
    inputs: PullRequestInputs,
  ): Operation<Result<GitHostCompletion>> {
    const attempt = yield* pulls.create(inputs);
    if (attempt.state === "settled") {
      if (!pullRequestAgrees(attempt.pullRequest, inputs)) {
        unusable("the Git host created a pull request other than the one it was asked for");
      }
      return Ok(completion(attempt.pullRequest));
    }
    if (attempt.state === "unreadable") {
      unusable("the Git host answered the creation with something this boundary cannot read");
    }

    // A race, a rejection or a failure with no word for it: what happened is
    // decided by observing once, never by a second attempt to create.
    const observed = yield* pulls.observe(inputs);
    if (observed.state === "found" && pullRequestAgrees(observed.pullRequest, inputs)) {
      return Ok(completion(observed.pullRequest));
    }
    // Everything else is unknown rather than absent or conflicting, and it is
    // published as such. A later explicit attempt starts again at observation,
    // where a conflict and an ambiguity have their own words — and nothing here
    // creates a second pull request to find out.
    return Err(new GitHostUnavailableError());
  }

  /** The required mutations, once each, and the one observation that decides. */
  function* updated(
    pulls: ReturnType<typeof gitHubPullRequests>,
    inputs: PullRequestInputs,
    before: PullRequestSnapshot,
  ): Operation<Result<GitHostCompletion>> {
    const attempt = yield* pulls.update(inputs, before);
    if (attempt.state === "unreadable") {
      unusable("the Git host answered the update with something this boundary cannot read");
    }
    if (attempt.state === "uncertain" || !pullRequestAgrees(attempt.pullRequest, inputs)) {
      // A rejected mutation, a partial multi-call update and a host that could
      // not be read afterwards are one answer: this attempt did not reach the
      // requested state. Nothing is repeated here — a later explicit attempt
      // observes what is now there and finishes only what is left.
      return Err(new GitHostUnavailableError());
    }
    if (!samePullRequestIdentity(before, attempt.pullRequest)) {
      unusable("the Git host answered with a pull request other than the one being updated");
    }
    return Ok(completion(attempt.pullRequest));
  }
}

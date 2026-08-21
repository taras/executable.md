/**
 * What `<PullRequest>` owns: one open pull request for one branch, exactly once.
 *
 * Built the way `<Git.Push>` is built, and for the same reason: a pull request
 * belongs to a Git host, and no transaction here reaches one. So this reads
 * everything it needs out of the Workspace, closes that transaction, proves
 * locally that it is allowed to act at all, and only then reconciles one
 * external effect through the shared Git-host state machine.
 *
 * ## Everything local happens first, and in this order
 *
 * 1. The request is detached, so nothing the caller does to its own objects
 *    afterwards reaches the effect this describes.
 * 2. One short read-only Workspace transaction authenticates the observed
 *    Repository record and working directory against the retained rows and
 *    exports the selected checkout family.
 * 3. The transaction closes. Everything after it reads files.
 * 4. The exported checkout is prepared and authenticated, and its current
 *    branch and `HEAD` are read from it — never from a document.
 * 5. This run's own journal is read, and a compatible successful `<Git.Push>`
 *    result is proven, before an adapter is selected, a token is read or a
 *    single request is sent.
 *
 * The order is the design. A pull request is a public statement, and every
 * question that can be answered without making one is answered without making
 * one — so a document that forgot to push, a checkout that moved, or a
 * Repository context that was replaced is refused with the Git host never
 * having heard of this run.
 *
 * ## What the provider is given, and what it is not
 *
 * The adapter needs to know which repository at which host, and what to
 * authenticate with. Both stay in this module's own closure: public Git-host
 * middleware sees the frozen JSON request #297 defines and no part of the
 * locator, the endpoint, the credential or the transport. The durable request
 * carries the Repository's filtered identity, the title, the body, the draft
 * flag and the branch pair — no host path, no locator, no credential and
 * nothing a provider said.
 */

import { Err, Ok, scoped, type Operation, type Result } from "effection";
import {
  GitOperationInfrastructureError,
  GitOperationProtocolError,
  PullRequestAuthorityError,
} from "../../composition/errors.ts";
import { PULL_REQUEST_ELEMENT } from "../../composition/components/PullRequest.ts";
import {
  filteredRepositoryIdentity,
  sameRepositoryIdentity,
} from "../../composition/git-push-records.ts";
import {
  parsePullRequestInputs,
  parsePullRequestPreState,
  parsePullRequestRecord,
  PULL_REQUEST,
  pullRequestAgrees,
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  pullRequestObservationsJson,
  pullRequestPreStateJson,
  pullRequestResultJson,
  pullRequestResultOf,
  samePullRequestIdentity,
  type PullRequestInputs,
  type PullRequestOutcome,
  type PullRequestRequest,
  type PullRequestSnapshot,
} from "../../composition/pull-request-records.ts";
import { admitPushEvidence } from "../../composition/push-evidence.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import { reconcileGitHostEffect, withGitHostProvider } from "../../git-host/effect.ts";
import { GitHostProviderError, GitHostUnavailableError } from "../../git-host/errors.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostObservation,
} from "../../git-host/records.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { transactWorkspaceRoots } from "../workspace/private.ts";
import { currentBranch, gitSession, resolveCommit } from "./git.ts";
import {
  denoGitHubSource,
  gitHubPullRequests,
  parseGitHubRepository,
  type GitHubAccess,
  type GitHubSource,
} from "./github.ts";
import type { RepositoryHost } from "./host.ts";
import {
  exportCheckoutFamily,
  prepareCheckout,
  selectGitCheckout,
  type GitCheckout,
} from "./operations.ts";

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
 * operation never authorized.
 */
function pullRequestProvider(
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

/** What this invocation asks for: the branch the checkout is on, at its commit. */
function* admitInputs(
  checkout: GitCheckout,
  admitted: PullRequestRequest,
): Operation<PullRequestInputs> {
  const headBranch = yield* currentBranch(checkout.git, checkout.directory);
  if (headBranch === undefined) {
    throw new PullRequestAuthorityError(
      "unnamed-branch",
      "the checkout it selected has no branch checked out, so there is no head branch to open a " +
        "pull request from — and a detached HEAD is not something this run could have published.",
    );
  }
  const headSha = yield* resolveCommit(checkout.git, checkout.directory, "HEAD");
  if (headSha === undefined) {
    unusable("the checkout it ran in did not report the commit its branch holds");
  }
  return Object.freeze({
    repository: filteredRepositoryIdentity(admitted.repository),
    number: admitted.number,
    title: admitted.title,
    body: admitted.body,
    draft: admitted.draft,
    headBranch,
    headSha,
    baseBranch: admitted.base,
  });
}

/**
 * The whole of what `<PullRequest>` asks for: one reconciled effect, exactly
 * parsed.
 *
 * Ordered so that everything a later step trusts has already been proven: the
 * retained rows and the export inside one short transaction, the exported
 * checkout's identity outside it, the branch and commit from that checkout,
 * this run's own proof that it published them, and only then a frozen request
 * and a provider that can answer for it.
 */
export function* upsertPullRequest(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: PullRequestRequest,
  source: GitHubSource = denoGitHubSource(),
): Operation<PullRequestOutcome> {
  // Admission takes a snapshot, and the snapshot is what the operation runs on.
  // A caller's request and the record inside it are its own objects, and this
  // operation has suspension points across which whoever handed them over can
  // still change them.
  const admitted: PullRequestRequest = Object.freeze({
    repository: Object.freeze({ ...request.repository }),
    workingDirectory: request.workingDirectory,
    number: request.number,
    title: request.title,
    body: request.body,
    draft: request.draft,
    base: request.base,
  });

  return yield* scoped(function* () {
    const root = yield* host.useDirectory();
    const git = gitSession(host, root);

    // Held open for the export alone. Everything after this reads files, and a
    // network round trip must never keep the run's database locked.
    const prepared = yield* transactWorkspaceRoots(database, function* (workspace) {
      const selection = selectGitCheckout(workspace.metadata, PULL_REQUEST_ELEMENT, admitted);
      return {
        selection,
        exported: yield* exportCheckoutFamily(workspace.filesystem, root, selection),
      };
    });
    if (!prepared.ok) {
      throw prepared.error;
    }
    const { selection, exported } = prepared.value;

    const checkout = yield* prepareCheckout(root, git, selection, exported, PULL_REQUEST_ELEMENT);
    const inputs = yield* admitInputs(checkout, admitted);

    // Before an adapter exists, before a token is read and before anything is
    // sent. What authorizes a pull request is this run's own record of
    // publishing the branch, so a refusal here happens with the Git host never
    // having been asked anything.
    const events = yield* database.journal.readAll();
    admitPushEvidence(events, inputs);

    // The exact retained locator, authenticated against its own fingerprint
    // when the row was read, rather than a `remote.origin.url` out of a
    // configuration file this run merely stores. It stays in the provider's
    // closure and reaches no durable or public value.
    const locator = selection.repository.locator;

    // One access session for this whole reconciliation, opened after the local
    // authority check above and shared by its observations and its mutation, so
    // a pull request is not created under one identity and observed under
    // another. It is disposed with the scope below; a later attempt on an
    // interrupted request opens its own.
    const access = yield* source.open();

    const record = yield* withGitHostProvider(
      pullRequestProvider(access, locator, inputs),
      reconcileGitHostEffect({
        kind: PULL_REQUEST,
        inputs: pullRequestInputsJson(inputs),
        naturalKey: pullRequestNaturalKeyJson(pullRequestNaturalKey(inputs)),
      }),
    );

    // Read for this invocation rather than merely read. The shared engine has
    // already held the record's request to the request being made; what is
    // decided here is that its three JSON members describe this exact pull
    // request and that the decision the engine recorded is one its pre-state
    // supports.
    const outcome = parsePullRequestRecord(record, inputs);
    if (outcome === undefined) {
      throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
    }
    return outcome;
  });
}

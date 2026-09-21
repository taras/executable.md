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
  PullRequestAdmissionError,
} from "../../composition/errors.ts";
import { PULL_REQUEST_ELEMENT } from "../../composition/components/PullRequest.ts";

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
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { readWorkflowWorkspace } from "@executablemd/workflow/deno";
import { readWorkspaceMetadata } from "../repositories.ts";
import { currentBranch, gitSession, resolveCommit } from "./git.ts";
import {
  gitHubPullRequests,
  parseGitHubRepository,
  type GitHubAccess,
  type GitHubSource,
} from "./github.ts";
import { denoGitHubSource } from "./github-host.ts";
import type { RepositoryHost } from "./host.ts";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import type { PullRequestResult } from "../../composition/pull-request-records.ts";
import type { SelectionRegistry } from "../selections.ts";
import type { RepositoryRecord } from "../../composition/records.ts";
import { GitOperationAdmissionError } from "../../composition/errors.ts";
import {
  gitHubPullRequestAccess,
  GITHUB,
  useGitHubPullRequestReads,
  type GitHubPullRequestsOptions,
} from "./pull-request-reads.ts";
import { pullRequestProvider } from "./github-pull-request.ts";
import { filteredRepositoryIdentity, sameRepositoryIdentity } from "../../composition/selection.ts";
import {
  exportCheckoutFamily,
  prepareCheckout,
  selectGitCheckout,
  type GitCheckout,
} from "./operations.ts";

/**
 * A refusal this orchestration makes, for something it could not establish.
 *
 * The adapter beside it has its own: each set answers for what it did, and
 * neither reaches into the other to say it.
 */
function unusable(reason: string): never {
  throw new GitOperationInfrastructureError(PULL_REQUEST_ELEMENT, reason);
}

/** What this invocation asks for: the branch the checkout is on, at its commit. */
function* admitInputs(
  checkout: GitCheckout,
  admitted: PullRequestRequest,
): Operation<PullRequestInputs> {
  const headBranch = yield* currentBranch(checkout.git, checkout.directory);
  if (headBranch === undefined) {
    throw new PullRequestAdmissionError(
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
    const prepared = yield* readWorkflowWorkspace(database, {}, function* (workspace) {
      const selection = selectGitCheckout(
        readWorkspaceMetadata(workspace.storage),
        PULL_REQUEST_ELEMENT,
        admitted,
      );
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
    // sent. What admits a pull request is this run's own record of
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
    // admission check above and shared by its observations and its mutation, so
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

/**
 * Install the workflow host's reconciled pull-request upsert, and its reads.
 *
 * The upsert is unchanged in everything but where it is reached from: it still
 * proves this run published the branch, still reconciles through the Git-host
 * engine, and still refuses a pull request belonging to another Repository. The
 * selection it is handed is resolved through the provider's own registry, never
 * believed, which is the same rule every Git operation follows.
 */
export function* useGitHubPullRequests(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  options: GitHubPullRequestsOptions,
  selections: SelectionRegistry<RepositoryRecord>,
): Operation<void> {
  const access = gitHubPullRequestAccess(options);

  yield* PullRequestAPI.around({
    *upsert([pullRequest, upsert], next): Operation<PullRequestResult> {
      const mine = upsert.provider === undefined || upsert.provider === GITHUB;
      if (!mine) {
        return yield* next(pullRequest, upsert);
      }
      const outcome = yield* upsertPullRequest(
        database,
        host,
        {
          // The record this provider itself holds for the selection, never the
          // selection's own words: a Repository nobody selected is exactly what
          // a replaced context would name.
          repository: selections.authenticate(
            upsert.repository,
            () =>
              new GitOperationAdmissionError(
                PULL_REQUEST_ELEMENT,
                "the Repository in scope is not one this run selected, so it names no retained " +
                  "checkout",
              ),
          ),
          workingDirectory: upsert.workingDirectory,
          number: pullRequest.number,
          title: pullRequest.title,
          body: pullRequest.body,
          draft: pullRequest.draft,
          base: pullRequest.base,
        },
        // The session, asked of the adapter that owns it. An upsert names a
        // branch this run published rather than a URL a document wrote, so
        // what is *allowed* does not reach it — but where the API lives is
        // still configuration, and the adapter reads that here rather than at
        // installation.
        yield* access(),
      );
      return outcome.result;
    },
  });
  yield* useGitHubPullRequestReads(options);
}

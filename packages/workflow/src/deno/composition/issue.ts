/**
 * What `<Issue>` owns: one open issue for one deferred obligation, exactly once.
 *
 * Built the way `<PullRequest>` is built, and for the same reason: an issue
 * belongs to a Git host, and no transaction here reaches one. So this reads what
 * it needs out of the Workspace, closes that transaction, proves locally that it
 * is allowed to act at all, and only then reconciles one external effect through
 * the shared Git-host state machine.
 *
 * ## Everything local happens first, and in this order
 *
 * 1. The request is detached, so nothing the caller does to its own objects
 *    afterwards reaches the effect this describes.
 * 2. One short read-only Workspace transaction authenticates the observed
 *    Repository record and working directory against the retained rows.
 * 3. This run's own journal is read, and a compatible successful
 *    `<PullRequest>` result is proven, before an adapter is selected, a token is
 *    read or a single request is sent.
 *
 * The approval this run already holds is the component's, and it is why nothing
 * here needs to ask about the disposition again: the only request that reaches
 * this operation is a deferral somebody approved by delivering a typed answer.
 *
 * ## No Git runs here
 *
 * An issue is a statement about a decision rather than about a tree, so nothing
 * is exported, materialized or read from a checkout. The enclosing Repository
 * and the contextual working directory are what select which retained
 * Repository is meant, and that selection is the whole of what the checkout is
 * for.
 *
 * ## What the provider is given, and what it is not
 *
 * The adapter needs to know which repository at which host, and what to
 * authenticate with. Both stay in this module's own closure: public Git-host
 * middleware sees the frozen JSON request §10.2 defines and no part of the
 * locator, the endpoint, the credential or the transport. The durable request
 * carries the Repository's filtered identity, the PullRequest evidence and the
 * document's own text — no host path, no locator, no credential and nothing a
 * provider said.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import {
  GitOperationInfrastructureError,
  GitOperationProtocolError,
} from "../../composition/errors.ts";
import { ISSUE_ELEMENT } from "../../composition/components/Issue.ts";
import { filteredRepositoryIdentity } from "../../composition/git-push-records.ts";
import { admitPullRequestEvidence } from "../../composition/pull-request-evidence.ts";
import {
  DEFER,
  ISSUE,
  issueAgrees,
  issueInputsJson,
  issueNaturalKey,
  issueNaturalKeyJson,
  issueObservationsJson,
  issuePreStateJson,
  issueResultJson,
  issueResultOf,
  parseIssueInputs,
  parseIssuePreState,
  parseIssueRecord,
  sameIssueIdentity,
  sameIssueInputs,
  type IssueInputs,
  type IssueOutcome,
  type IssueRequest,
  type IssueSnapshot,
} from "../../composition/issue-records.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import { reconcileGitHostEffect, withGitHostProvider } from "../../git-host/effect.ts";
import { GitHostProviderError, GitHostUnavailableError } from "../../git-host/errors.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostEffectIdentity,
  GitHostObservation,
} from "../../git-host/records.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { transactWorkspaceRoots } from "../workspace/private.ts";
import {
  denoGitHubAccess,
  gitHubIssues,
  parseGitHubRepository,
  type GitHubAccess,
  type GitHubIssues,
} from "./github.ts";
import { selectGitCheckout } from "./operations.ts";

function unusable(reason: string): never {
  throw new GitOperationInfrastructureError(ISSUE_ELEMENT, reason);
}

/**
 * A pre-state that claims nothing.
 *
 * The three refusing observations publish no record — the engine journals a
 * conflict, an ambiguity and an unavailability as the effect's failed result
 * and discards everything the observation carried — so what a refusal saw at
 * the Git host has no reason to be described. An issue somebody else opened is
 * their text, and this is the boundary that exists to keep it there.
 */
const NOTHING_PROVEN = issuePreStateJson({ issue: null });

/** What this invocation asks for, filtered to what durable JSON may carry. */
function admittedInputs(request: IssueRequest): IssueInputs {
  return Object.freeze({
    repository: filteredRepositoryIdentity(request.repository),
    pullRequest: request.pullRequest,
    finding: request.finding,
    disposition: DEFER,
    title: request.title,
    body: request.body,
    rationale: request.rationale,
    dependencyImpact: request.dependencyImpact,
    intendedTiming: request.intendedTiming,
  });
}

/**
 * The provider that answers this exact reconciliation, and no other.
 *
 * Installed around one `reconcileGitHostEffect()` call and reachable only from
 * inside it. Its closure holds the parsed repository name, the endpoint and the
 * credential source; what it receives from the engine is the frozen request,
 * which it parses and holds to the inputs this invocation admitted. A request
 * naming another Repository, another pull request or other text is not this
 * invocation's, and answering one would publish a completion for something this
 * operation never authorized.
 */
function issueProvider(
  access: GitHubAccess,
  locator: string,
  admitted: IssueInputs,
): GitHostProvider {
  interface Admitted {
    readonly inputs: IssueInputs;
    readonly identity: GitHostEffectIdentity;
  }

  function admit(request: CompleteGitHostEffectRequest): Admitted {
    const inputs = parseIssueInputs(request.inputs);
    if (request.kind !== ISSUE || inputs === undefined || !sameIssueInputs(inputs, admitted)) {
      unusable("the Git host asked this provider about an issue this invocation did not describe");
    }
    return { inputs, identity: request.identity };
  }

  /** The adapter for this Repository, or a refusal of the whole effect kind. */
  function adapter(): GitHubIssues | undefined {
    const name = parseGitHubRepository(locator);
    return name === undefined ? undefined : gitHubIssues(access, name);
  }

  function completion(admittedRequest: Admitted, issue: IssueSnapshot): GitHostCompletion {
    return {
      observations: issueObservationsJson({ issue }),
      result: issueResultJson(issueResultOf(admittedRequest.inputs, issue)),
    };
  }

  return {
    *observe(request): Operation<Result<GitHostObservation>> {
      const asked = admit(request);
      const adapted = adapter();
      if (adapted === undefined) {
        // Said from observation and before any remote work, which is exactly
        // how §10.2 has a host decline a kind it does not implement. The
        // locator itself is not repeated: what this run holds for it is a
        // fingerprint, and that is what a reader has.
        return Err(
          new GitHostProviderError(
            "this Git host adapter records issues only for repositories on github.com",
          ),
        );
      }

      const observed = yield* adapted.observe(asked.inputs, asked.identity);
      if (observed.state === "unavailable") {
        // Not absence. A host that could not answer has proven nothing, and
        // offering silence as absence is what would record this obligation a
        // second time.
        return Err(new GitHostUnavailableError());
      }
      if (observed.state === "ambiguous") {
        return Ok({ state: "ambiguous", preState: NOTHING_PROVEN });
      }
      if (observed.state === "conflict") {
        return Ok({ state: "conflict", preState: NOTHING_PROVEN });
      }
      if (observed.state === "absent") {
        return Ok({ state: "absent", preState: NOTHING_PROVEN });
      }

      const found = observed.issue;
      if (issueAgrees(found, asked.inputs, asked.identity)) {
        // The obligation is already recorded, saying exactly this. That is the
        // issue an interrupted attempt created, and the shared adoption is what
        // it is: the pre-state and the observations are one reading of it.
        const adopted = completion(asked, found);
        return Ok({
          state: "compatible",
          preState: issuePreStateJson({ issue: found }),
          observations: adopted.observations,
          result: adopted.result,
        });
      }

      // The obligation is recorded, and what it says is not what this run
      // decided. Absent is the shared machine's word for "the requested
      // completion is not there", and the pre-state is what is there instead —
      // which is how a performed update can describe what it acted on.
      return Ok({ state: "absent", preState: issuePreStateJson({ issue: found }) });
    },

    *perform(request, observation): Operation<Result<GitHostCompletion>> {
      const asked = admit(request);
      const adapted = adapter();
      if (adapted === undefined) {
        unusable("the Git host that proved absence is not the one being asked to act");
      }

      // Which of the two this is, is decided by the proven absence itself. The
      // engine reaches `perform` only from `absent`, and the pre-state it
      // carries is this attempt's own observation: nothing there, or the issue
      // this obligation already has as it stood a moment ago.
      const before = parseIssuePreState(observation.preState);
      if (before === undefined) {
        unusable("the proven absence this attempt acts on describes no pre-state");
      }
      return before.issue === null
        ? yield* created(adapted, asked)
        : yield* updated(adapted, asked, before.issue);
    },
  };

  /** One creation, and one observation if its outcome is uncertain. */
  function* created(adapted: GitHubIssues, asked: Admitted): Operation<Result<GitHostCompletion>> {
    const attempt = yield* adapted.create(asked.inputs, asked.identity);
    if (attempt.state === "settled") {
      if (!issueAgrees(attempt.issue, asked.inputs, asked.identity)) {
        unusable("the Git host created an issue other than the one it was asked for");
      }
      return Ok(completion(asked, attempt.issue));
    }
    if (attempt.state === "unreadable") {
      unusable("the Git host answered the creation with something this boundary cannot read");
    }

    // A race, a rejection or a failure with no word for it: what happened is
    // decided by observing once, never by a second attempt to create.
    const observed = yield* adapted.observe(asked.inputs, asked.identity);
    if (observed.state === "found" && issueAgrees(observed.issue, asked.inputs, asked.identity)) {
      return Ok(completion(asked, observed.issue));
    }
    // Everything else is unknown rather than absent or conflicting, and it is
    // published as such. A later explicit attempt starts again at observation,
    // where a conflict and an ambiguity have their own words — and nothing here
    // creates a second issue to find out.
    return Err(new GitHostUnavailableError());
  }

  /** The required mutations, once each, and the one observation that decides. */
  function* updated(
    adapted: GitHubIssues,
    asked: Admitted,
    before: IssueSnapshot,
  ): Operation<Result<GitHostCompletion>> {
    const attempt = yield* adapted.update(asked.inputs, asked.identity, before);
    if (attempt.state === "unreadable") {
      unusable("the Git host answered the update with something this boundary cannot read");
    }
    if (
      attempt.state === "uncertain" ||
      !issueAgrees(attempt.issue, asked.inputs, asked.identity)
    ) {
      // A rejected mutation and a host that could not be read afterwards are
      // one answer: this attempt did not reach the requested state. Nothing is
      // repeated here — a later explicit attempt observes what is now there and
      // finishes only what is left.
      return Err(new GitHostUnavailableError());
    }
    if (!sameIssueIdentity(before, attempt.issue)) {
      unusable("the Git host answered with an issue other than the one being updated");
    }
    return Ok(completion(asked, attempt.issue));
  }
}

/**
 * The whole of what `<Issue>` asks for: one reconciled effect, exactly parsed.
 *
 * Ordered so that everything a later step trusts has already been proven: the
 * retained rows inside one short transaction, this run's own proof that it
 * reconciled the pull request being recorded, and only then a frozen request and
 * a provider that can answer for it.
 */
export function* upsertIssue(
  database: WorkflowRunDatabase,
  request: IssueRequest,
  access: GitHubAccess = denoGitHubAccess(),
): Operation<IssueOutcome> {
  // Admission takes a snapshot, and the snapshot is what the operation runs on.
  // A caller's request and the records inside it are its own objects, and this
  // operation has suspension points across which whoever handed them over can
  // still change them.
  const admitted: IssueRequest = Object.freeze({
    repository: Object.freeze({ ...request.repository }),
    workingDirectory: request.workingDirectory,
    finding: request.finding,
    disposition: DEFER,
    pullRequest: Object.freeze({
      ...request.pullRequest,
      repository: Object.freeze({ ...request.pullRequest.repository }),
    }),
    title: request.title,
    rationale: request.rationale,
    dependencyImpact: request.dependencyImpact,
    intendedTiming: request.intendedTiming,
    body: request.body,
  });

  // Held open for the selection alone. Everything after this reads the journal
  // or a Git host, and a network round trip must never keep the run's database
  // locked.
  const selected = yield* transactWorkspaceRoots(database, function* (workspace) {
    return selectGitCheckout(workspace.metadata, ISSUE_ELEMENT, admitted);
  });
  if (!selected.ok) {
    throw selected.error;
  }
  const selection = selected.value;

  const inputs = admittedInputs(admitted);

  // Before an adapter exists, before a token is read and before anything is
  // sent. What authorizes an issue is this run's own record of reconciling the
  // pull request it records, so a refusal here happens with the Git host never
  // having been asked anything.
  const events = yield* database.journal.readAll();
  admitPullRequestEvidence(events, inputs.pullRequest, inputs.repository);

  // The exact retained locator, authenticated against its own fingerprint when
  // the row was read, rather than a `remote.origin.url` out of a configuration
  // file this run merely stores. It stays in the provider's closure and reaches
  // no durable or public value.
  const locator = selection.repository.locator;

  const record = yield* withGitHostProvider(
    issueProvider(access, locator, inputs),
    reconcileGitHostEffect({
      kind: ISSUE,
      inputs: issueInputsJson(inputs),
      naturalKey: issueNaturalKeyJson(issueNaturalKey(inputs)),
    }),
  );

  // Read for this invocation rather than merely read. The shared engine has
  // already held the record's request to the request being made; what is
  // decided here is that its three JSON members describe this exact issue and
  // that the decision the engine recorded is one its pre-state supports.
  const outcome = parseIssueRecord(record, inputs);
  if (outcome === undefined) {
    throw new GitOperationProtocolError(ISSUE_ELEMENT);
  }
  return outcome;
}

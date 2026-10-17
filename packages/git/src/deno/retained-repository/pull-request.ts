/**
 * One REPL entry's `<PullRequest>`: asked once, reconciled once, answered from
 * what the Git host said.
 *
 * `push.ts` beside this is the same shape for the same reasons, and this
 * operation is built on top of what that one proves. A publication changes a
 * branch at a remote; a pull request is a *statement about* a branch that is
 * already there, so before anything is written down this entry has to be able
 * to show that it published the head the pull request names. That evidence is
 * the entry's own private publication memory, and nothing else is accepted —
 * not a receipt-shaped value, not a local `<Git.Commit>` result, not a
 * handler's `Git.push` answer, and not another entry's history.
 *
 * Everything after that follows publication's order exactly: resolve one
 * complete request out of the checkout, write that request down, and only then
 * reconcile the external effect through the shared Git-host state machine. An
 * entry that opens a pull request, leaves at a question and is reopened an hour
 * later finds the request it already made — the same head, the same base, the
 * same body — and reconciles *that* rather than whatever the checkout has
 * become since. A completed upsert answers from its saved receipt and contacts
 * nobody.
 *
 * ## Two chains, and what a handler may decide
 *
 * A fresh invocation dispatches through two invocation-local defaults under the
 * two stable Api names, so every public handler a document or a plugin composed
 * at either level still answers, transforms, refuses and delegates exactly as
 * it does in an ordinary run. The profile-level default reaches the transport
 * surface; the transport-level default is this entry's own terminal, and it is
 * the only thing here that writes anything down.
 *
 * What a handler may decide is what to ask for. What it may not decide is what
 * was answered. A handler that answers without delegating has answered the
 * document and nothing more: no request is written, no Git host is asked, no
 * receipt exists, and the value it bound has none of the stability a retained
 * one has. But once the owned terminal has actually run, its outcome is kept
 * privately as a `Result` and that outcome is what binds or fails — an outer
 * handler that rewrites the return cannot bind a different pull request, and
 * one that swallows a delegated failure and returns a success cannot turn a
 * refusal into one. A throw of the outer chain's own after a success is
 * ordinary surrounding failure and is left alone.
 *
 * ## A saved request bypasses the middleware it already passed
 *
 * On a continuation the saved request is consumed before anything is
 * dispatched. The transformation a handler applied the first time is already
 * inside that record; re-dispatching would let a changed handler retarget
 * external work this entry has already admitted.
 */

import { createApi } from "@effectionx/context-api";
import { Err, Ok, until, useScope } from "effection";
import type { Operation, Result, Scope } from "effection";
import { realpath } from "node:fs/promises";
import { createDurableOperation } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import { content, documented, hasContent } from "@executablemd/core";
import type { ComponentInvocation, FunctionComponent } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import { cwd } from "@executablemd/runtime";
import { COMPOSITION_ORIGIN } from "../../composition/definitions.ts";
import {
  authoredPullRequest,
  documentation as pullRequestDocumentation,
  props as pullRequestProps,
  PULL_REQUEST_ELEMENT,
  returns as pullRequestReturns,
} from "../../composition/components/PullRequest.ts";
import { selectedRepository } from "../../composition/context.ts";
import {
  GitOperationAdmissionError,
  GitOperationInfrastructureError,
  GitOperationProtocolError,
  PullRequestAdmissionError,
} from "../../composition/errors.ts";
import { NoPullRequestProvider, PULL_REQUEST_API } from "../../composition/pull-request-api.ts";
import type {
  PullRequestApi,
  PullRequestInput,
  PullRequestReadOptions,
  PullRequestUpsertOptions,
} from "../../composition/pull-request-api.ts";
import {
  PULL_REQUEST_OPERATIONS,
  PullRequestOperationsProviderError,
} from "../../composition/pull-request-operations.ts";
import type {
  PullRequestOperationsApi,
  PullRequestReadInvocation,
  PullRequestUpsertInvocation,
} from "../../composition/pull-request-operations.ts";
import {
  parseClosedPullRequestResult,
  parsePullRequestRecord,
  pullRequestResultJson,
  type PullRequestInputs,
  type PullRequestResult,
} from "../../composition/pull-request-records.ts";
import { sameRepositoryIdentity } from "../../composition/selection.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import { reconcileOwnedGitHostEffect } from "../../git-host/effect.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import type { GitHostReconciliationRecord } from "../../git-host/records.ts";
import { replPullRequestEffectRequest } from "../../retained-repository/push-admission.ts";
import type { ReplPushPlacement } from "../../retained-repository/push-admission.ts";
import {
  parseReplPullRequestRequestRecord,
  replPullRequestRequestJson,
  replPullRequestRequestName,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  sameReplPullRequestAsk,
  type ReplPullRequestAsk,
  type ReplPullRequestRequestRecord,
  type ReplPullRequestResolution,
} from "../../retained-repository/pull-request-records.ts";
import type { ReplPushPlace } from "../../retained-repository/push-records.ts";
import { locatorFingerprint } from "../composition/locator.ts";
import { currentBranch, resolveCommit } from "../composition/git.ts";
import type { GitHubSource } from "../composition/github.ts";
import { gitHubPullRequestAccess } from "../composition/pull-request-reads.ts";
import type { GitHubPullRequestsOptions } from "../composition/pull-request-reads.ts";
import { pullRequestProvider } from "../composition/github-pull-request.ts";
import { gitRefusal } from "../composition/refusals.ts";
import { liveCheckout, selectCheckout } from "../run-composition/operations.ts";
import { holdManagedPlacement } from "./leases.ts";
import type { ReplGitCheckout } from "./git.ts";
import { retainedRecordAhead } from "./local.ts";
import type { ReplPushAccess, ReplPushEntry } from "./push.ts";
import { placementSubject } from "./selections.ts";
import type { ReplPlacementRegistration } from "./selections.ts";

/**
 * The entry's own `PullRequest`, declared as an ordinary shadowable component.
 *
 * It shadows the inherited bundled registration for this execution's scope
 * without touching it, so a repository-local `<PullRequest>` keeps its ordinary
 * precedence over both. The name is neither reserved nor protected: what a
 * replacement does not get is an identity authenticator, so it names no durable
 * work of this entry's.
 *
 * Inspection describes one `PullRequest` — the same origin, props, return
 * contract, forms and prose the bundled registration carries — because it is
 * the same component with this entry's identity behind it.
 */
export function replPullRequestComponent(
  owner: string,
  access: ReplPushAccess,
  options: GitHubPullRequestsOptions = {},
): IdentityComponent {
  const upstream = gitHubPullRequestAccess(options);
  return {
    name: "PullRequest",
    origin: COMPOSITION_ORIGIN,
    props: pullRequestProps,
    returns: pullRequestReturns,
    // Both authored forms, as the bundled registration has them: a pull request
    // with no body is written `<PullRequest title="..." />` and its body is the
    // empty string. Unlike `<Issue>`, the form selects no second effect, so
    // reading the content contextually decides nothing but what the body says.
    forms: ["self-closing", "paired"],
    ...documented(pullRequestDocumentation),
    factory: (claim: IdentityClaimant) => upsertingBody(owner, access, upstream, claim),
  };
}

function upsertingBody(
  owner: string,
  access: ReplPushAccess,
  upstream: () => Operation<GitHubSource>,
  claim: IdentityClaimant,
): FunctionComponent {
  return function* PullRequest(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<Json> {
    // Before this element projects its own content, because an invocation names
    // nothing while it is expanding what is inside it — and after it would be
    // naming the identity from a frame the children have already left.
    const site = yield* claim(invocation);
    // Then the body, and completely, before a Repository is observed and before
    // this upsert has a position of its own. A child durable operation in that
    // content finishes at its own earlier position, and a body that failed to
    // render stops everything this component owns before a request exists.
    const body = (yield* hasContent()) ? yield* content() : "";

    const repository = yield* selectedRepository();
    if (repository === undefined) {
      throw new PullRequestAdmissionError(
        "no-repository-context",
        "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
          "pull request to be opened in.",
      );
    }
    const result = yield* upsert({
      owner,
      site,
      access,
      upstream,
      pullRequest: authoredPullRequest(props, body, repository.identity.primaryBranch),
      repository,
      workingDirectory: yield* cwd(),
    });
    return pullRequestResultJson(result);
  };
}

interface Invocation {
  readonly owner: string;
  readonly site: string;
  readonly access: ReplPushAccess;
  readonly upstream: () => Operation<GitHubSource>;
  readonly pullRequest: PullRequestInput;
  readonly repository: RepositorySelection;
  readonly workingDirectory: string;
}

/**
 * Open or update this invocation's pull request, or reconcile the request it
 * already made.
 *
 * The saved request is looked for first, and found without consuming anything:
 * a position holding this invocation's own request is answered from that
 * request, and only an invocation with nothing saved dispatches, resolves and
 * writes one down.
 */
function* upsert(invocation: Invocation): Operation<PullRequestResult> {
  const entry = held(invocation.access);
  const registration = authenticated(entry, invocation.repository);
  const requested: ReplPullRequestAsk = Object.freeze({
    pullRequest: invocation.pullRequest,
    place: Object.freeze({
      repository: registration.placement.identity,
      selectionCheckout: registration.placement.checkoutRoot,
      commonDirectory: registration.placement.commonDirectory,
      // Exactly as received. Resolving it is live routing, which a continuation
      // does not do, so the name cannot depend on it.
      workingDirectory: invocation.workingDirectory,
    }),
  });
  const name = yield* replPullRequestRequestName({
    owner: invocation.owner,
    site: invocation.site,
    requested,
  });

  if (yield* retainedRecordAhead(REPL_REPOSITORY_PULL_REQUEST_REQUEST, name)) {
    const saved = yield* restored(entry, invocation, requested, name);
    return yield* reconcile(entry, invocation, saved);
  }

  // Two invocation-local defaults under the two stable Api names, so the
  // middleware a document or a plugin composed at either level applies and each
  // chain ends in this invocation's own terminal rather than in the public
  // refusing default. Nothing but this dispatch holds them, and they are
  // revoked below.
  const live: Dispatch = { open: true, delegated: false, owned: undefined };
  const transport = createApi<PullRequestApi>(PULL_REQUEST_API, {
    upsert: (
      pullRequest: PullRequestInput,
      options: PullRequestUpsertOptions,
    ): Operation<PullRequestResult> =>
      ownedUpsert(entry, invocation, requested, name, live, pullRequest, options),
    // The public refusal, for a member this descriptor never routes. It is
    // unreachable through it — the only call made on it is the upsert below —
    // and declaring it any other way would make this invocation's private
    // terminal answer for a collection it owns nothing about.
    read: refusingRead(),
  });
  const profile = createApi<PullRequestOperationsApi>(PULL_REQUEST_OPERATIONS, {
    // Straight through to the transport surface, for the same reason the
    // workflow profile passes through: what makes this upsert durable lives
    // underneath, and retaining here would hold one answer under two
    // identities.
    upsert: (invoked: PullRequestUpsertInvocation): Operation<PullRequestResult> =>
      transport.operations.upsert(invoked.pullRequest, {
        repository: invoked.repository,
        workingDirectory: invoked.workingDirectory,
      }),
    read: refusingOperationsRead(),
  });

  let answered: PullRequestResult;
  try {
    answered = yield* profile.operations.upsert({
      pullRequest: invocation.pullRequest,
      repository: invocation.repository,
      workingDirectory: invocation.workingDirectory,
    });
  } finally {
    live.open = false;
  }

  const owned = live.owned;
  if (owned === undefined) {
    // Nothing delegated to this entry's terminal, so a handler answered the
    // document itself. That answer may bind, but it is not a pull request this
    // entry asked for: no request, no receipt, and none of the stability a
    // retained result has. What it must still be is the closed contract this
    // component promises, because a document reads its binding through it.
    const synthetic = parseClosedPullRequestResult(
      pullRequestResultJson(answered),
      invocation.repository.identity.objectFormat,
    );
    if (synthetic === undefined) {
      throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
    }
    return synthetic;
  }
  // The owned outcome decides, not what came back up the chain. A rewritten
  // return cannot bind another pull request, and a delegated failure a handler
  // caught and answered past stays a failure.
  if (!owned.ok) {
    throw owned.error;
  }
  return owned.value;
}

/** What one invocation's own defaults have done, where only it can reach. */
interface Dispatch {
  /** Whether the invocation that captured these defaults is still running. */
  open: boolean;
  /** Whether a delegation has already reached the owned terminal. */
  delegated: boolean;
  /** The outcome that one delegation produced, as the authority on binding. */
  owned: Result<PullRequestResult> | undefined;
}

/**
 * The one delegation this invocation's terminal accepts.
 *
 * It snapshots the delegated input once, authenticates it, resolves the
 * complete request, proves this entry published the head, writes the request
 * down and reconciles it. A second use refuses before another request or
 * another worker call: the first delegation may have already opened a pull
 * request, and nothing here cancels or repeats acknowledged external work.
 */
function* ownedUpsert(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPullRequestAsk,
  name: string,
  live: Dispatch,
  pullRequest: PullRequestInput,
  options: PullRequestUpsertOptions,
): Operation<PullRequestResult> {
  if (!live.open) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the pull request it belongs to has finished, so this dispatch names no invocation. " +
        "Nothing was asked of the Git host",
    );
  }
  if (live.delegated) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "this pull request was already dispatched once. A second delegation of one <PullRequest> " +
        "would ask the Git host again about work this invocation has already acknowledged, so " +
        "nothing was asked of it",
    );
  }
  live.delegated = true;

  // Read once, here. The arguments are the caller's own objects and everything
  // below suspends, so reading them again later would let one pull request be
  // authenticated and another opened.
  const received: ReplPullRequestAsk = Object.freeze({
    pullRequest: Object.freeze({
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      draft: pullRequest.draft,
      base: pullRequest.base,
    }),
    place: placeOf(entry, options.repository, options.workingDirectory),
  });

  // Held privately whichever way it goes, before anything up the chain can see
  // it. A failure recorded here is what stops a handler from catching it and
  // answering the document with a success instead.
  const outcome = yield* attempt(entry, invocation, requested, received, name);
  live.owned = outcome;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** The transport surface's own refusal, for a member this descriptor never routes. */
function refusingRead(): PullRequestApi["read"] {
  // deno-lint-ignore require-yield
  return function* (url: string, options: PullRequestReadOptions): Operation<never> {
    throw new NoPullRequestProvider("read", url, options.provider);
  };
}

/** The profile surface's own refusal, on the same terms. */
function refusingOperationsRead(): PullRequestOperationsApi["read"] {
  // deno-lint-ignore require-yield
  return function* (invoked: PullRequestReadInvocation): Operation<never> {
    throw new PullRequestOperationsProviderError(`a <PullRequest.${invoked.kind}>`);
  };
}

/** The owned attempt, as the `Result` that decides this invocation's binding. */
function* attempt(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPullRequestAsk,
  received: ReplPullRequestAsk,
  name: string,
): Operation<Result<PullRequestResult>> {
  try {
    const resolved = yield* resolve(entry, invocation, received);
    const record = yield* publishRequest(entry, invocation, requested, received, resolved, name);
    return Ok(yield* reconcile(entry, invocation, record));
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The complete request this invocation opens, resolved from the checkout.
 *
 * Publication's order, for publication's reasons: the checkout covering the
 * received directory, the destination this repository belongs to, the managed
 * slot that says this entry owns that checkout, and only then — inside the
 * entry's own native turn — the branch it is on and the commit that branch
 * holds.
 *
 * Then the question this protocol adds: whether this entry actually published
 * that head. It is asked here, before a request is written, before an adapter
 * is built, before a credential is read and before anything is contacted.
 */
function* resolve(
  entry: ReplPushEntry,
  invocation: Invocation,
  received: ReplPullRequestAsk,
): Operation<ReplPullRequestResolution> {
  const routed = yield* route(entry, received.place);
  const placement = routed.registration.placement;
  const origin = yield* destination(routed.registration);

  yield* own(entry, routed);

  const git = yield* entry.git();
  // Serialized with this entry's own native Git, because reading HEAD beside a
  // `<Git.Commit>` of the same repository would describe a moment neither of
  // them is at. The turn is held for these two short reads and released before
  // anything is contacted: a network round trip never holds it.
  const read = yield* entry.serialize(`git ${placement.commonDirectory}`, function* () {
    const checkout = liveCheckout(git, routed.checkout, received.place.workingDirectory);
    const branch = yield* currentBranch(checkout.git, checkout.directory);
    if (branch === undefined) {
      throw gitRefusal(PULL_REQUEST_ELEMENT, "unnamed-branch");
    }
    const headSha = yield* resolveCommit(checkout.git, checkout.directory, "HEAD");
    if (headSha === undefined) {
      throw new GitOperationInfrastructureError(
        PULL_REQUEST_ELEMENT,
        "the checkout it ran in did not report the commit its branch holds",
      );
    }
    return { branch, headSha };
  });

  const inputs: PullRequestInputs = Object.freeze({
    repository: received.place.repository,
    number: received.pullRequest.number,
    title: received.pullRequest.title,
    body: received.pullRequest.body,
    draft: received.pullRequest.draft,
    headBranch: read.branch,
    headSha: read.headSha,
    baseBranch: received.pullRequest.base,
  });

  // This entry's own account of publishing that head, and nothing else. A
  // refusal here happens with the Git host never having been asked anything.
  entry.publications.admit(inputs, origin);

  return Object.freeze({
    checkoutRoot: routed.checkout.root,
    commonDirectory: placement.commonDirectory,
    origin,
    inputs,
  });
}

/**
 * Where this checkout's pull requests belong, as this entry can see it now.
 *
 * The locator the entry admitted, held to the fingerprint the Repository
 * identity carries — the same question publication asks, because a pull request
 * opened against an origin nothing authenticated would be a statement about
 * somebody else's repository.
 */
function* destination(registration: ReplPlacementRegistration): Operation<string> {
  const origin = yield* registration.origin();
  if (origin === undefined) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the checkout it selected records no usable origin, so there is no repository for this " +
        "pull request to be opened in. No credential was read and nothing was contacted",
    );
  }
  if (locatorFingerprint(origin) !== registration.placement.identity.locatorFingerprint) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the origin this checkout records is not the one the Repository in scope was selected " +
        "from, so a pull request opened against it would name a repository this entry never " +
        "authenticated",
    );
  }
  return origin;
}

/**
 * Write this request down, and read it back before it is acknowledged.
 *
 * The request is one durable position and the reconciliation below is another:
 * they are two inline operations rather than one wrapped in the other, because
 * a request that was acknowledged and an outcome that was not is exactly the
 * history a continuation has to be able to read.
 */
function* publishRequest(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPullRequestAsk,
  received: ReplPullRequestAsk,
  resolved: ReplPullRequestResolution,
  name: string,
): Operation<ReplPullRequestRequestRecord> {
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name },
    function* () {
      const payload = replPullRequestRequestJson({
        owner: invocation.owner,
        site: invocation.site,
        requested,
        received,
        resolved,
      });
      readback(entry, invocation, requested, payload);
      return payload;
    },
    { coordinator: requestCoordinator },
  );
  return readback(entry, invocation, requested, stored);
}

/**
 * The saved request standing at this position, read back for this invocation.
 *
 * Reached only when the cursor already holds this invocation's own request. The
 * callback below is the engine's to run and this position's history says it will
 * not: a live attempt here would write a request nothing resolved, so it refuses
 * rather than inventing one.
 */
function* restored(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPullRequestAsk,
  name: string,
): Operation<ReplPullRequestRequestRecord> {
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      throw new GitOperationInfrastructureError(
        PULL_REQUEST_ELEMENT,
        "its retained history named a saved pull-request request at this position and then had " +
          "none, so what this entry asked the Git host for is unknown",
      );
    },
    { coordinator: requestCoordinator },
  );
  return readback(entry, invocation, requested, stored);
}

/**
 * The record this value is for this invocation, or the fatal failure it is not.
 *
 * The same five questions on both paths, which is the point: a resolved request
 * is held to them before it is written, and a restored one before it is
 * reconciled. The payload parses, it is this entry's and this invocation's, it
 * asks the question this position is asking, every place it names is one this
 * entry's own registry holds, and the origin it says it belongs to is the one
 * the Repository identity in it was fingerprinted from.
 *
 * That last question is asked here rather than in the codec because the digest
 * is this half of the package's: a surface naming no runtime has no synchronous
 * one, and a restored request is reconciled against the origin it recorded
 * rather than against today's.
 */
function readback(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPullRequestAsk,
  stored: unknown,
): ReplPullRequestRequestRecord {
  const record = parseReplPullRequestRequestRecord(stored);
  if (record === undefined) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  if (
    record.owner !== invocation.owner ||
    record.site !== invocation.site ||
    !sameReplPullRequestAsk(record.requested, requested)
  ) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  if (!placesHeld(record, placements(entry))) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  if (
    locatorFingerprint(record.resolved.origin) !==
    record.resolved.inputs.repository.locatorFingerprint
  ) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  return record;
}

/** Whether every place this saved request names is one this entry holds. */
function placesHeld(
  record: ReplPullRequestRequestRecord,
  held: readonly ReplPushPlacement[],
): boolean {
  const places: readonly (readonly [string, string])[] = [
    [record.requested.place.selectionCheckout, record.requested.place.commonDirectory],
    [record.received.place.selectionCheckout, record.received.place.commonDirectory],
    [record.resolved.checkoutRoot, record.resolved.commonDirectory],
  ];
  return places.every(([checkoutRoot, commonDirectory]) =>
    held.some(
      (placement) =>
        placement.checkoutRoot === checkoutRoot &&
        placement.commonDirectory === commonDirectory &&
        sameRepositoryIdentity(placement.identity, record.received.place.repository),
    ),
  );
}

/** The places this entry's reconstructed registry holds, as parsed facts. */
function placements(entry: ReplPushEntry): readonly ReplPushPlacement[] {
  return entry.checkouts().map((checkout) => ({
    identity: checkout.registration.placement.identity,
    checkoutRoot: checkout.registration.placement.checkoutRoot,
    commonDirectory: checkout.registration.placement.commonDirectory,
  }));
}

/**
 * Reconcile this request's external effect, and hold the result to the request.
 *
 * A completed outcome comes back before any native work, any adapter, any
 * configuration and any credential: the shared worker replays it without
 * constructing a provider at all. A pending one reaches the live provider below,
 * using the saved request's own head, base, number, title, body and draft rather
 * than rereading a checkout whose HEAD has usually moved.
 */
function* reconcile(
  entry: ReplPushEntry,
  invocation: Invocation,
  record: ReplPullRequestRequestRecord,
): Operation<PullRequestResult> {
  const inputs = record.resolved.inputs;
  const reconciliation = yield* reconcileOwnedGitHostEffect(
    {
      owner: invocation.owner,
      site: invocation.site,
      request: replPullRequestEffectRequest(inputs),
    },
    {
      provider: () => upstreamProvider(entry, invocation, record),
      validate: (produced: GitHostReconciliationRecord) => {
        if (parsePullRequestRecord(produced, inputs) === undefined) {
          throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
        }
      },
    },
  );
  const outcome = parsePullRequestRecord(reconciliation, inputs);
  if (outcome === undefined) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  return outcome.result;
}

/**
 * The provider that answers this exact upsert, built inside the attempt.
 *
 * Reached only by a live attempt. The access session belongs to that attempt's
 * own scope, so what the observation opened is still open when the upsert
 * performs, and it is closed and joined before the reconciliation may
 * acknowledge a result.
 *
 * It needs no checkout, no object source and no native hold. A pull request is
 * a question for the service about a branch the host already has, and the saved
 * request already says which branch and which commit — so a pending one is
 * reconciled without asking today's filesystem anything.
 */
function* upstreamProvider(
  entry: ReplPushEntry,
  invocation: Invocation,
  record: ReplPullRequestRequestRecord,
): Operation<GitHostProvider> {
  const resolved = record.resolved;
  // The saved checkout, authenticated against this entry's own registry rather
  // than against the filesystem. A root this entry holds no placement for is
  // not somewhere it may open a pull request from, however the record came to
  // name it.
  const routed = entry
    .checkouts()
    .find(
      (checkout) =>
        checkout.registration.placement.checkoutRoot === resolved.checkoutRoot &&
        checkout.registration.placement.commonDirectory === resolved.commonDirectory &&
        sameRepositoryIdentity(
          checkout.registration.placement.identity,
          resolved.inputs.repository,
        ),
    );
  if (routed === undefined) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the checkout its saved request names is not one this entry holds a placement for, so " +
        "this pull request cannot be reconciled. Nothing was contacted",
    );
  }

  const attempt: Scope = yield* useScope();
  // Where the API lives is configuration, read here rather than at
  // installation, so an entry that writes no `<PullRequest>` reads none of it.
  const source = yield* invocation.upstream();
  // One session for this whole reconciliation, shared by its observations and
  // its mutation, so a pull request is not created under one identity and
  // observed under another. It is a resource of the attempt's own scope.
  const access = yield* attempt.run(() => source.open());
  return pullRequestProvider(access, resolved.origin, resolved.inputs);
}

/**
 * Which registered checkout this repository and working directory select.
 *
 * The ordinary selector over this entry's own registrations, restricted by the
 * whole authenticated Repository identity and resolving the received directory
 * first. The longest covering checkout wins, so a subdirectory, a linked
 * worktree and a captured path entered through `<Dir>` each select the checkout
 * their own paths belong to.
 */
function* route(entry: ReplPushEntry, received: ReplPushPlace): Operation<ReplGitCheckout> {
  const registered = entry.checkouts();
  const selected = selectCheckout(
    registered.map((checkout) => checkout.checkout),
    received.repository,
    yield* canonical(received.workingDirectory),
    PULL_REQUEST_ELEMENT,
  );
  const found = registered.find((checkout) => checkout.checkout.root === selected.root);
  if (found === undefined) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the checkout it selected is not one this entry holds a placement for",
    );
  }
  return found;
}

/**
 * Take ownership of the checkout this pull request is opened from.
 *
 * The managed slot alone, as publication takes it: the slot says which entry
 * owns a managed checkout, which is what reading its branch and head needs. No
 * mutation lease, because a pull request changes no checkout, index, branch or
 * tracking configuration.
 */
function* own(entry: ReplPushEntry, target: ReplGitCheckout): Operation<void> {
  const registration = target.registration;
  const slot = registration.slot;
  const root = registration.placement.managedRoot;
  if (slot === undefined || root === undefined) {
    return;
  }
  yield* holdManagedPlacement(() =>
    entry.holdSlot(root, slot.kind, slot.path, placementSubject(registration.placement)),
  );
}

/** One reading of where this pull request was asked for. */
function placeOf(
  entry: ReplPushEntry,
  selection: RepositorySelection,
  workingDirectory: string,
): ReplPushPlace {
  const registration = authenticated(entry, selection);
  return Object.freeze({
    repository: registration.placement.identity,
    selectionCheckout: registration.placement.checkoutRoot,
    commonDirectory: registration.placement.commonDirectory,
    workingDirectory,
  });
}

/**
 * The canonical directory this path resolves to, or the path as written.
 *
 * Routing resolves the received directory exactly as recorded local Git and
 * publication do, because a working directory reached through a link is the
 * same place under another name. Only live routing resolves anything: a saved
 * request's roots are authenticated against parsed placements instead.
 */
function* canonical(path: string): Operation<string> {
  try {
    return yield* until(realpath(path));
  } catch {
    return path;
  }
}

/** The private entry state this execution holds, or the ordinary refusal. */
function held(access: ReplPushAccess): ReplPushEntry {
  const entry = access();
  if (entry === undefined) {
    // The same failure the public surface's own default raises, because that is
    // what this condition is: no retained pull-request capability was
    // established for this execution, so nothing performed anything.
    throw new PullRequestOperationsProviderError(PULL_REQUEST_ELEMENT);
  }
  return entry;
}

/** What this selection names in this entry's registry, or an admission refusal. */
function authenticated(
  entry: ReplPushEntry,
  selection: RepositorySelection,
): ReplPlacementRegistration {
  return entry.selections.authenticate(
    selection,
    () =>
      new GitOperationAdmissionError(
        PULL_REQUEST_ELEMENT,
        "the Repository in scope is not one this entry selected, so it names no checkout",
      ),
  );
}

/**
 * The live boundary one written request passes through.
 *
 * The default coordinator would serialize whatever was thrown and publish it as
 * this operation's outcome, which is the one thing that must not happen here: a
 * request written for work nobody resolved would send a continuation to
 * reconcile a pull request this entry never asked for.
 *
 * A throw therefore activates the run's existing fail-stop state and is
 * re-raised with its identity intact, writing nothing. A valid request is
 * written once and returned only after the append is acknowledged, which is what
 * makes "no service contact before the request exists" a property of the
 * ordering rather than a promise.
 */
const requestCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: ProtocolResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<ProtocolResult> {
    let value: T;
    try {
      value = yield* execute();
    } catch (error) {
      throw activateFailure(error);
    }
    const result: ProtocolResult = { status: "ok", value };
    yield* publish(result);
    return result;
  },
};

/**
 * How one REPL entry opens or updates a pull request, and what it retains.
 *
 * Two records at two positions, for the reason the entry's publication keeps
 * two: the request is written down *before* the Git host is contacted, and the
 * host's own outcome is reconciled afterwards under the shared Git-host
 * contract. Reopen the entry between them and the saved request is what the
 * next attempt reconciles — the exact title, body, head and destination it
 * originally named, however far the checkout has moved since.
 *
 * ## What authorizes it
 *
 * A pull request is a statement about a branch that already exists at the Git
 * host, so this entry's own acknowledged publication of that branch is what
 * admits it. That proof is read from the paired history admission already
 * performed, before a request is written, before a credential is read and
 * before anything is contacted. Another checkout's publication, another entry's,
 * a synthetic middleware answer and a failed or pending Push authorize nothing.
 *
 * ## What it takes, and what it does not
 *
 * The managed slot alone, which says this entry owns the checkout it reads the
 * branch and head from. No mutation lease: a pull request changes no checkout,
 * no index, no branch and no tracking configuration, so an entry holding that
 * lease elsewhere does not stop this one. A detached HEAD, an absent origin and
 * an unregistered selection each refuse before a request, a credential or
 * remote contact exists.
 *
 * ## Recovery reads what was saved
 *
 * At a saved-request position the record is restored and reconciled as it
 * stands. Nothing rereads HEAD, the branch, the title or the body from today's
 * checkout, and nothing retargets it through middleware it already passed: the
 * head the host was asked about is the head that was resolved then. A completed
 * outcome returns before native state, a slot, a provider or a credential is
 * acquired, and a pending one opens only the live attempt needed to reconcile
 * the inputs already saved.
 */

import { createApi } from "@effectionx/context-api";
import { until } from "effection";
import type { Operation } from "effection";
import { realpath } from "node:fs/promises";
import { createDurableOperation } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import { PULL_REQUEST_ELEMENT } from "@executablemd/git";
import {
  GitCompositionProviderError,
  GitOperationAdmissionError,
  GitOperationInfrastructureError,
  GitOperationProtocolError,
  PullRequestAdmissionError,
} from "@executablemd/git";
import type { BindOperations } from "@executablemd/git";
import { PULL_REQUEST_OPERATIONS } from "@executablemd/git/api";
import type {
  PullRequestOperationsApi,
  PullRequestReadInvocation,
  PullRequestUpsertInvocation,
} from "@executablemd/git/api";
import {
  parsePullRequestRecord,
  type PullRequestInputs,
  type PullRequestResult,
} from "@executablemd/git";
import { locatorFingerprint } from "@executablemd/git/deno";
import { sameRepositoryIdentity } from "@executablemd/git/api";
import type { RepositorySelection } from "@executablemd/git/api";
import { reconcileOwnedGitHostEffect } from "@executablemd/git/api";
import type { GitHostProvider } from "@executablemd/git";
import type { GitHostReconciliationRecord } from "@executablemd/git";
import {
  replPullRequestEffectRequest,
  replPullRequestPlacesHeld,
  type ReplPushPlacement,
} from "../push-admission.ts";
import { proveReplPullRequestPublication } from "../pull-request-admission.ts";
import {
  parseReplPullRequestRequestRecord,
  replPullRequestRequestJson,
  replPullRequestRequestName,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  sameReplPullRequestAsked,
  type ReplPullRequestAsked,
  type ReplPullRequestContent,
  type ReplPullRequestPlace,
  type ReplPullRequestRequestRecord,
  type ReplPullRequestResolution,
} from "../pull-request-records.ts";
import type { DenoPullRequestOperations } from "@executablemd/git/deno";
import { gitRefusal } from "@executablemd/git/deno";
import { selectCheckout } from "@executablemd/git/deno";
import { holdManagedPlacement } from "./leases.ts";
import type { ReplGitCheckout } from "./git.ts";
import { retainedRecordAhead } from "./local.ts";
import { nativeGitTurn, placementSubject } from "./selections.ts";
import type { ReplPlacementRegistration } from "./selections.ts";
import type { ReplPushAccess, ReplPushEntry } from "./push.ts";

/**
 * How this entry performs one `<PullRequest>`.
 *
 * The policy the common declaration is built with. It is called once per
 * invocation, with the site the binding authenticated, and what it answers with
 * is that invocation's own upsert operation.
 *
 * The site reaches no public input and no journal name of its own. Its parsed
 * facts are what the saved request carries, because the opaque identifier this
 * entry minted names nothing once the entry ends.
 */
export function replPullRequestPolicy(
  owner: string,
  access: ReplPushAccess,
  pullRequests: () => DenoPullRequestOperations,
): BindOperations<PullRequestOperationsApi["upsert"]> {
  return (site: string) => (request: PullRequestUpsertInvocation) =>
    upsert({
      owner,
      site,
      access,
      pullRequests,
      invocation: request,
    });
}

interface Invocation {
  readonly owner: string;
  readonly site: string;
  readonly access: ReplPushAccess;
  /** This entry's pull-request domain, inert until something needs a session. */
  readonly pullRequests: () => DenoPullRequestOperations;
  readonly invocation: PullRequestUpsertInvocation;
}

/**
 * Upsert this invocation's pull request, or reconcile the request it already
 * made.
 *
 * The saved request is looked for first, and found without consuming anything:
 * a position holding this invocation's own request is answered from that
 * request, and only an invocation with nothing saved dispatches, resolves,
 * proves its publication and writes one down.
 */
function* upsert(call: Invocation): Operation<PullRequestResult> {
  const entry = held(call.access);
  // Read once, before anything suspends: the invocation is the caller's own
  // object, and a value read again later could leave the record naming one
  // title and the host asked about another.
  const registration = authenticated(entry, call.invocation.repository);
  const requested: ReplPullRequestAsked = Object.freeze({
    place: placeOf(registration, call.invocation.workingDirectory),
    pullRequest: contentOf(call.invocation),
  });
  const name = yield* replPullRequestRequestName({
    owner: call.owner,
    site: call.site,
    requested,
  });

  if (yield* retainedRecordAhead(REPL_REPOSITORY_PULL_REQUEST_REQUEST, name)) {
    const saved = yield* restored(entry, call, requested, name);
    return yield* reconcile(entry, call, saved);
  }

  // One operation-local default under the stable Api name: the shared
  // middleware chain applies, and the chain ends in this invocation's own
  // terminal rather than in the public refusing default. Nothing but this
  // dispatch holds it, and it is revoked below.
  const live: Dispatch = { open: true, delegated: false };
  const local = createApi<PullRequestOperationsApi>(PULL_REQUEST_OPERATIONS, {
    upsert: (request: PullRequestUpsertInvocation): Operation<PullRequestResult> =>
      delegated(entry, call, requested, name, live, request),
    // The read keeps the public refusal. It is unreachable through this
    // descriptor — the only call made on it is the upsert below — and declaring
    // it any other way would make this invocation's private terminal answer for
    // an operation it owns nothing about.
    read: refusingRead(),
  });
  try {
    // What a handler answers with is not read as evidence. A synthetic answer
    // has answered the document; it is not a receipt, it saves no request and
    // no outcome, and it grants no publication.
    return yield* local.operations.upsert(call.invocation);
  } finally {
    live.open = false;
  }
}

/** What one invocation's own default has done, where only it can reach. */
interface Dispatch {
  /** Whether the invocation that captured this default is still running. */
  open: boolean;
  /** Whether a delegation has already reached it. */
  delegated: boolean;
}

/**
 * The one delegation this invocation's default accepts.
 *
 * It snapshots the received request once, authenticates it, resolves the
 * complete inputs, proves this entry published the branch, publishes the
 * request and reconciles it. A second use refuses before another request or
 * another worker call: the first delegation may have already opened a pull
 * request, and nothing here cancels or repeats acknowledged external work.
 */
function* delegated(
  entry: ReplPushEntry,
  call: Invocation,
  requested: ReplPullRequestAsked,
  name: string,
  live: Dispatch,
  request: PullRequestUpsertInvocation,
): Operation<PullRequestResult> {
  if (!live.open) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the upsert it belongs to has finished, so this dispatch names no invocation. Nothing was " +
        "asked of the Git host",
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

  // Read once, here, for the reason the question above is read once.
  const receivedSelection = request.repository;
  const receivedDirectory = request.workingDirectory;
  const registration = authenticated(entry, receivedSelection);
  const received: ReplPullRequestAsked = Object.freeze({
    place: placeOf(registration, receivedDirectory),
    pullRequest: contentOf(request),
  });

  const resolved = yield* resolve(entry, received);

  // Before the request exists, before a credential and before the host is
  // contacted: what admits a pull request is this entry's own acknowledged
  // publication of the branch it names.
  yield* proveReplPullRequestPublication(call.owner, {
    repository: received.place.repository,
    origin: resolved.origin,
    branch: resolved.inputs.headBranch,
    destinationRef: destinationRefFor(resolved.inputs.headBranch),
    checkoutRoot: resolved.checkoutRoot,
    commonDirectory: resolved.commonDirectory,
    headSha: resolved.inputs.headSha,
  });

  const record = yield* publishRequest(entry, call, requested, received, resolved, name);
  return yield* reconcile(entry, call, record);
}

/**
 * The complete inputs this invocation asks for, resolved from the checkout.
 *
 * Everything a later step trusts is proven before it: the checkout covering the
 * received directory, the origin this repository belongs to, the managed slot
 * that says this entry owns that checkout, and only then — inside the entry's
 * own native turn — the branch it is on and the commit that branch holds.
 *
 * Nothing contacts a remote and nothing reads a credential.
 */
function* resolve(
  entry: ReplPushEntry,
  received: ReplPullRequestAsked,
): Operation<ReplPullRequestResolution> {
  const routed = yield* route(entry, received);
  const placement = routed.registration.placement;
  const origin = yield* destination(routed.registration);
  yield* own(entry, routed);

  // Serialized with this entry's own native Git, because reading HEAD beside a
  // `<Git.Commit>` of the same repository would describe a moment neither of
  // them is at. The turn is held for these two short reads and released before
  // anything is contacted.
  const read = yield* entry.serialize(nativeGitTurn(placement.commonDirectory), function* () {
    const directory = routed.checkout.root;
    const branch = yield* entry.operations.currentBranch(directory);
    if (branch === undefined) {
      throw gitRefusal(PULL_REQUEST_ELEMENT, "unnamed-branch");
    }
    const headSha = yield* entry.operations.resolveCommit(directory, "HEAD");
    if (headSha === undefined) {
      throw new GitOperationInfrastructureError(
        PULL_REQUEST_ELEMENT,
        "the checkout it ran in did not report the commit its branch holds",
      );
    }
    return { branch, headSha };
  });

  const content = received.pullRequest;
  const inputs: PullRequestInputs = Object.freeze({
    repository: received.place.repository,
    number: content.number,
    title: content.title,
    body: content.body,
    draft: content.draft,
    headBranch: read.branch,
    headSha: read.headSha,
    baseBranch: content.base,
  });
  return Object.freeze({
    checkoutRoot: routed.checkout.root,
    commonDirectory: placement.commonDirectory,
    origin,
    inputs,
  });
}

function destinationRefFor(branch: string): string {
  return `refs/heads/${branch}`;
}

/**
 * Which origin this checkout belongs to, as this entry can see it now.
 *
 * The locator the entry admitted, held to the fingerprint the Repository
 * identity carries. A checkout that records no usable origin belongs to no
 * remote repository a pull request could be opened on, and one whose origin
 * does not name this repository is not somewhere this invocation may act —
 * both before a request exists and before anything is contacted.
 */
function* destination(registration: ReplPlacementRegistration): Operation<string> {
  const origin = yield* registration.origin();
  if (origin === undefined) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the checkout it selected records no usable origin, so there is no remote repository for " +
        "a pull request to be opened in. No credential was read and nothing was contacted",
    );
  }
  if (locatorFingerprint(origin) !== registration.placement.identity.locatorFingerprint) {
    throw new GitOperationAdmissionError(
      PULL_REQUEST_ELEMENT,
      "the origin this checkout records is not the one the Repository in scope was selected " +
        "from, so a pull request opened against it would name somewhere this entry never " +
        "authenticated",
    );
  }
  return origin;
}

/**
 * Write this request down, and read it back before it is acknowledged.
 *
 * The request is one durable position and the reconciliation below is another:
 * two inline operations rather than one wrapped in the other, because a request
 * that was acknowledged and an outcome that was not is exactly the history a
 * continuation has to be able to read.
 */
function* publishRequest(
  entry: ReplPushEntry,
  call: Invocation,
  requested: ReplPullRequestAsked,
  received: ReplPullRequestAsked,
  resolved: ReplPullRequestResolution,
  name: string,
): Operation<ReplPullRequestRequestRecord> {
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name },
    function* () {
      const payload = replPullRequestRequestJson({
        owner: call.owner,
        site: call.site,
        requested,
        received,
        resolved,
      });
      readback(entry, call, requested, payload);
      return payload;
    },
    { coordinator: requestCoordinator },
  );
  return readback(entry, call, requested, stored);
}

/**
 * The saved request standing at this position, read back for this invocation.
 *
 * Reached only when the cursor already holds this invocation's own request. The
 * callback below is the engine's to run and this position's history says it
 * will not: a live attempt here would publish a request nothing resolved, so it
 * refuses rather than inventing one.
 */
function* restored(
  entry: ReplPushEntry,
  call: Invocation,
  requested: ReplPullRequestAsked,
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
  return readback(entry, call, requested, stored);
}

/**
 * The record this value is for this invocation, or the fatal failure it is not.
 *
 * The same five questions on both paths, which is the point: a resolved request
 * is held to them before it is published, and a restored one before it is
 * reconciled. The payload parses, it is this entry's and this invocation's, it
 * asks the question this position is asking, every place it names is one this
 * entry's own registry holds, and the origin it says it belongs to is the one
 * the Repository identity in it was fingerprinted from.
 */
function readback(
  entry: ReplPushEntry,
  call: Invocation,
  requested: ReplPullRequestAsked,
  stored: unknown,
): ReplPullRequestRequestRecord {
  const record = parseReplPullRequestRequestRecord(stored);
  if (record === undefined) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  if (
    record.owner !== call.owner ||
    record.site !== call.site ||
    !sameReplPullRequestAsked(record.requested, requested)
  ) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  if (!replPullRequestPlacesHeld(record, placements(entry))) {
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
 * A completed outcome comes back before any native work, any resource and any
 * credential: the shared worker replays it without constructing a provider at
 * all. A pending one reaches the live provider below.
 */
function* reconcile(
  entry: ReplPushEntry,
  call: Invocation,
  record: ReplPullRequestRequestRecord,
): Operation<PullRequestResult> {
  const inputs = record.resolved.inputs;
  const reconciliation = yield* reconcileOwnedGitHostEffect(
    {
      owner: call.owner,
      site: call.site,
      request: replPullRequestEffectRequest(inputs),
    },
    {
      provider: () => upsertProvider(entry, call, record),
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
 * Reached only by a live attempt, and the access session it opens belongs to
 * that attempt's own scope — so the observation and the mutation it decided go
 * out under one identity, and it is closed and joined before publication may
 * acknowledge a result.
 *
 * A pending pull request needs no checkout and no object source: its original
 * publication was already admitted and its saved remote inputs are sufficient.
 * What is authenticated here is the saved origin against the saved identity,
 * because the record is reconciled against the origin it recorded rather than
 * against today's.
 */
function* upsertProvider(
  entry: ReplPushEntry,
  call: Invocation,
  record: ReplPullRequestRequestRecord,
): Operation<GitHostProvider> {
  const resolved = record.resolved;
  const inputs = resolved.inputs;
  if (locatorFingerprint(resolved.origin) !== inputs.repository.locatorFingerprint) {
    throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
  }
  if (!replPullRequestPlacesHeld(record, placements(entry))) {
    throw new PullRequestAdmissionError(
      "unreadable-push-evidence",
      "the checkout its saved request names is not one this entry holds a placement for, so " +
        "what it asked the Git host for cannot be accounted for by this entry.",
    );
  }
  // Opened inside the owned attempt that asked for a live provider, which is
  // what keeps the session's lifetime that attempt's rather than this entry's.
  return yield* call.pullRequests().provider(resolved.origin, inputs);
}

/**
 * Which checkout this invocation's pull request reads its branch from.
 *
 * The entry's own registry decides, restricted by the whole authenticated
 * Repository identity and resolving the received directory first. The longest
 * covering checkout wins, so a subdirectory, a linked worktree and a captured
 * path entered through `<Dir>` each select the checkout their own paths belong
 * to.
 */
function* route(entry: ReplPushEntry, received: ReplPullRequestAsked): Operation<ReplGitCheckout> {
  const registered = entry.checkouts();
  const selected = selectCheckout(
    registered.map((checkout) => checkout.checkout),
    received.place.repository,
    yield* canonical(received.place.workingDirectory),
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
 * Take ownership of the checkout this pull request reads from.
 *
 * The managed slot alone, which says which entry owns a managed checkout. The
 * mutation lease says which entry is *changing* a repository, and a pull
 * request changes none of it. An ambient target has no slot: it is the checkout
 * the person was already standing in.
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

function placeOf(
  registration: ReplPlacementRegistration,
  workingDirectory: string,
): ReplPullRequestPlace {
  return Object.freeze({
    repository: registration.placement.identity,
    selectionCheckout: registration.placement.checkoutRoot,
    commonDirectory: registration.placement.commonDirectory,
    // Exactly as received. Resolving it is live routing, which a continuation
    // does not do, so the name cannot depend on it.
    workingDirectory,
  });
}

function contentOf(request: PullRequestUpsertInvocation): ReplPullRequestContent {
  const pullRequest = request.pullRequest;
  return Object.freeze({
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    draft: pullRequest.draft,
    base: pullRequest.base,
  });
}

/**
 * The canonical directory this path resolves to, or the path as written.
 *
 * Only live routing resolves anything: a saved request's roots are
 * authenticated against parsed placements instead.
 */
function* canonical(path: string): Operation<string> {
  try {
    return yield* until(realpath(path));
  } catch {
    return path;
  }
}

/** The public default's own refusal, for the member this descriptor never routes. */
function refusingRead(): (invocation: PullRequestReadInvocation) => Operation<never> {
  // deno-lint-ignore require-yield
  return function* (): Operation<never> {
    throw new GitCompositionProviderError(PULL_REQUEST_ELEMENT);
  };
}

/** The private entry state this execution holds, or the ordinary refusal. */
function held(access: ReplPushAccess): ReplPushEntry {
  const entry = access();
  if (entry === undefined) {
    // The same failure the public Api's own default raises, because that is
    // what this condition is: no local capability was established for this
    // execution, so nothing performed anything.
    throw new GitCompositionProviderError(PULL_REQUEST_ELEMENT);
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
 * The live boundary one published request is written through.
 *
 * The default coordinator would serialize whatever was thrown and publish it as
 * this operation's outcome, which is the one thing that must not happen here: a
 * request published for work nobody resolved would send a continuation to
 * reconcile a pull request this entry never described.
 *
 * A throw therefore activates the run's existing fail-stop state and is
 * re-raised with its identity intact, publishing nothing. A valid request is
 * published once and returned only after the append is acknowledged, which is
 * what makes "no remote work before the request exists" a property of the
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

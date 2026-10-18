/**
 * One REPL entry's `<Git.Push />`: asked once, reconciled once, answered from
 * what the Git host said.
 *
 * `git.ts` beside this records Add, Switch and Commit, whose outcomes a local
 * transaction encloses. A publication's outcome belongs to a remote, and
 * nothing here reaches it, so this operation is built the other way round: it
 * resolves one complete request out of the checkout, writes that request down,
 * and only then reconciles the external effect through the shared Git-host
 * state machine.
 *
 * That order is the whole feature. An entry that publishes a branch, leaves at
 * a question and is reopened an hour later finds the request it already made —
 * the same branch, the same commit, the same destination — and reconciles *that*
 * rather than whatever HEAD has become since. A completed publication answers
 * from its saved receipt and contacts nobody.
 *
 * ## What a document writes, and what it cannot reach
 *
 * `<Git.Push />` is the one shared component, with the origin, props and prose
 * it already had. What this host adds is policy beneath it: the common
 * invocation binding authenticates each invocation and hands this policy the
 * site it authenticated, and the policy owns its private owner and site
 * throughout. Neither reaches public Git input, so a replacement registration —
 * or a direct `Git.operations.push(...)` from anywhere — names no durable work
 * of this entry's and reaches the ordinary missing-provider refusal.
 *
 * A fresh invocation dispatches through an operation-local default under the
 * stable Git Api name, so every public handler a document or a plugin composed
 * still answers, transforms, refuses and delegates exactly as it does in an
 * ordinary run. What that default adds is retention, and it adds it once: a
 * second delegation of the same invocation is refused rather than published
 * twice, and the default is revoked when the invocation ends.
 *
 * A handler that answers without delegating has answered the document, and
 * nothing more: no request is written down, no Git host is asked, and no
 * receipt exists. A middleware return is never read as publication.
 *
 * ## A saved request bypasses the middleware it already passed
 *
 * On a continuation the saved request is consumed before anything is
 * dispatched. The transformation a handler applied the first time is already
 * inside that record; re-dispatching would let a changed handler retarget
 * external work this entry has already admitted, which is the one thing a
 * reconciliation must not allow.
 *
 * ## Resources, and what the window is honest about
 *
 * A live attempt opens its scratch transport, its object source and its
 * credential session inside the attempt's own scope: what observation opened is
 * still open when the push performs, and all of it is closed and joined before
 * publication may acknowledge anything. The publication window stays explicit —
 * a remote can accept a branch and the journal can fail to record it — and the
 * next attempt observes the destination and adopts the completion rather than
 * repeating it.
 */

import { createApi } from "@effectionx/context-api";
import { until, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { realpath } from "node:fs/promises";
import { createDurableOperation } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import type { JournalAdmission } from "@executablemd/core/host";
import { PUSH } from "../../composition/components/GitPush.ts";
import {
  GitCompositionProviderError,
  GitOperationAdmissionError,
  GitOperationInfrastructureError,
  GitOperationProtocolError,
} from "../../composition/errors.ts";
import { GIT_API } from "../../composition/git-api.ts";
import type { GitApi, GitPushInvocation } from "../../composition/git-api.ts";
import type { BindOperations } from "../../composition/invocation-binding.ts";
import {
  destinationRefFor,
  parseGitPushRecord,
  pushExpectation,
  PUSH_REMOTE,
  type GitPushInputs,
  type GitPushOutcome,
} from "../../composition/git-push-records.ts";
import { locatorFingerprint } from "../composition/locator.ts";
import { sameRepositoryIdentity } from "../../composition/selection.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import { reconcileOwnedGitHostEffect } from "../../git-host/effect.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import type { GitHostReconciliationRecord } from "../../git-host/records.ts";
import {
  admitReplPushHistory,
  replPushEffectRequest,
  replPushPlacesHeld,
  type ReplPushPlacement,
} from "../../retained-repository/push-admission.ts";
import {
  parseReplPushRequestRecord,
  replPushRequestJson,
  replPushRequestName,
  REPL_REPOSITORY_PUSH_REQUEST,
  type ReplPushPlace,
  type ReplPushRequestRecord,
  type ReplPushResolution,
} from "../../retained-repository/push-records.ts";
import { currentBranch, commitPresent, resolveCommit } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import { useGitAuthentication } from "../composition/host.ts";
import type { RepositoryHost } from "../composition/host.ts";
import type { GitAuthenticationSession } from "../composition/authentication.ts";
import { objectSourceAt } from "../composition/object-source.ts";
import { pushProvider } from "../composition/push.ts";
import { gitRefusal } from "../composition/refusals.ts";
import { lazily } from "../run-composition/lazy.ts";
import type { SlotKind } from "../run-composition/leases.ts";
import { liveCheckout, selectCheckout } from "../run-composition/operations.ts";
import type { SelectionRegistry } from "../selections.ts";
import { holdManagedPlacement } from "./leases.ts";
import type { ReplGitCheckout } from "./git.ts";
import { retainedRecordAhead } from "./local.ts";
import { nativeGitTurn, placementSubject } from "./selections.ts";
import type { ReplPlacementRegistration } from "./selections.ts";

/**
 * What recorded publication needs from the entry that owns it.
 *
 * The private state one initialized entry delivers into this feature's own
 * closure. Every member is a function or a registry this provider created: none
 * of it is published through Context, returned to a host, or reachable from a
 * document, a prop or middleware.
 *
 * There is no mutation lease here, and that is deliberate. A publication reads
 * authenticated objects and changes a branch on a remote; it changes no
 * checkout, index, branch or tracking configuration, so it takes the managed
 * slot that says which entry owns a checkout and nothing that excludes another
 * entry from changing a repository.
 */
export interface ReplPushEntry {
  /** The native Git host, which also lends a locator's authentication. */
  readonly host: RepositoryHost;
  /** This entry's Git session, acquired once into the entry's own scope. */
  git(): Operation<GitSession>;
  /** Hold a managed slot for the entry, single-flight per root and slot. */
  holdSlot(root: string, kind: SlotKind, path: string, subject: string): Operation<void>;
  /** Run live native Git for one shared Git directory in order within this entry. */
  serialize<T>(key: string, work: () => Operation<T>): Operation<T>;
  /** This entry's private map from the selections it minted to what it holds. */
  readonly selections: SelectionRegistry<ReplPlacementRegistration>;
  /** The checkouts this entry has registered, as they stand now. */
  checkouts(): readonly ReplGitCheckout[];
}

/**
 * This execution's private entry state, or the ordinary refusal.
 *
 * Revoked with the execution that initialized it, so a body that kept the
 * accessor past its own entry reaches nothing. An entry with no managed root
 * delivers none at all, which is what leaves `<Git.Push />` exactly the
 * missing-provider refusal it reaches when no checkout was ever selected.
 */
export type ReplPushAccess = () => ReplPushEntry | undefined;

/** What this entry requires of the publication records its history holds. */
export function replPushAdmission(owner: string): JournalAdmission {
  return (retained) => admitReplPushHistory(owner, retained);
}

/**
 * How this entry performs one `<Git.Push />`.
 *
 * The policy the common declaration is built with. It is called once per
 * invocation, with the site the binding authenticated, and what it answers with
 * is that invocation's own publication operation: the shared component asks it,
 * and everything about retention, dispatch and reconciliation happens below
 * this line.
 *
 * The site reaches no public Git input and no journal name of its own. Its
 * parsed facts are what the saved request carries, because the opaque
 * identifier this entry minted names nothing once the entry ends.
 */
export function replPushPolicy(
  owner: string,
  access: ReplPushAccess,
): BindOperations<GitApi["push"]> {
  return (site: string, gate) => (request: GitPushInvocation) =>
    gate.once(() =>
      publish({
        owner,
        site,
        access,
        repository: request.repository,
        workingDirectory: request.workingDirectory,
      }),
    );
}

interface Invocation {
  readonly owner: string;
  readonly site: string;
  readonly access: ReplPushAccess;
  readonly repository: RepositorySelection;
  readonly workingDirectory: string;
}

/**
 * Publish this invocation's branch, or reconcile the request it already made.
 *
 * The saved request is looked for first, and found without consuming anything:
 * a position holding this invocation's own request is answered from that
 * request, and only an invocation with nothing saved dispatches, resolves and
 * writes one down.
 */
function* publish(invocation: Invocation): Operation<GitPushOutcome> {
  const entry = held(invocation.access);
  // Authenticated before anything else, and its *parsed* facts are what the
  // request carries. The opaque identifier this entry minted never appears: it
  // names nothing once the entry ends, so a durable name built from one would
  // differ on every reopen of the same question.
  const registration = authenticated(entry, invocation.repository);
  const requested: ReplPushPlace = Object.freeze({
    repository: registration.placement.identity,
    selectionCheckout: registration.placement.checkoutRoot,
    commonDirectory: registration.placement.commonDirectory,
    // Exactly as received. Resolving it is live routing, which a continuation
    // does not do, so the name cannot depend on it.
    workingDirectory: invocation.workingDirectory,
  });
  const name = yield* replPushRequestName({
    owner: invocation.owner,
    site: invocation.site,
    requested,
  });

  if (yield* retainedRecordAhead(REPL_REPOSITORY_PUSH_REQUEST, name)) {
    const saved = yield* restored(entry, invocation, requested, name);
    return yield* reconcile(entry, invocation, saved);
  }

  // One operation-local default under the stable Api name: the shared
  // middleware chain applies, and the chain ends in this invocation's own
  // terminal rather than in the public refusing default. Nothing but this
  // dispatch holds it, and it is revoked below.
  const live: Dispatch = { open: true, delegated: false, settled: undefined };
  const local = createApi<GitApi>(GIT_API, {
    push: (request: GitPushInvocation): Operation<GitPushOutcome> =>
      delegated(entry, invocation, requested, name, live, request),
    // The three local operations keep the public refusal. They are unreachable
    // through this descriptor — the only call made on it is the publication
    // below, and middleware receives a continuation rather than the descriptor
    // — and declaring them any other way would make this invocation's private
    // terminal answer for operations it owns nothing about.
    switch: refusing("<Git.Switch>"),
    add: refusing("<Git.Add>"),
    commit: refusing("<Git.Commit>"),
  });
  try {
    // What a handler answers with is not read as evidence. A synthetic answer
    // has answered the document; it is not a receipt, and this operation
    // retains nothing for it.
    return yield* local.operations.push({
      repository: invocation.repository,
      workingDirectory: invocation.workingDirectory,
    });
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
  /** The outcome the one delegation produced, for a handler that asks again. */
  settled: GitPushOutcome | undefined;
}

/**
 * The one delegation this invocation's default accepts.
 *
 * It snapshots the received request once, authenticates it, resolves and
 * publishes the complete request, and reconciles it. A second use refuses
 * before another request or another worker call: the first delegation may have
 * already published a branch, and nothing here cancels or repeats acknowledged
 * external work.
 */
function* delegated(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPushPlace,
  name: string,
  live: Dispatch,
  request: GitPushInvocation,
): Operation<GitPushOutcome> {
  if (!live.open) {
    throw new GitOperationAdmissionError(
      PUSH,
      "the publication it belongs to has finished, so this dispatch names no invocation. " +
        "Nothing was asked of the Git host",
    );
  }
  if (live.delegated) {
    throw new GitOperationAdmissionError(
      PUSH,
      "this publication was already dispatched once. A second delegation of one <Git.Push /> " +
        "would ask the Git host again about work this invocation has already acknowledged, so " +
        "nothing was asked of it",
    );
  }
  live.delegated = true;

  // Read once, here. The invocation is the caller's own object and everything
  // below suspends, so reading it again later would let one Repository be
  // authenticated and another published for.
  const receivedSelection = request.repository;
  const receivedDirectory = request.workingDirectory;
  const registration = authenticated(entry, receivedSelection);
  const received: ReplPushPlace = Object.freeze({
    repository: registration.placement.identity,
    selectionCheckout: registration.placement.checkoutRoot,
    commonDirectory: registration.placement.commonDirectory,
    workingDirectory: receivedDirectory,
  });

  const resolved = yield* resolve(entry, received);
  const record = yield* publishRequest(entry, invocation, requested, received, resolved, name);
  const outcome = yield* reconcile(entry, invocation, record);
  live.settled = outcome;
  return outcome;
}

/**
 * The complete request this invocation publishes, resolved from the checkout.
 *
 * Everything a later step trusts is proven before it: the checkout covering the
 * received directory, the destination this repository publishes to, the managed
 * slot that says this entry owns that checkout, and only then — inside the
 * entry's own native turn — the branch it is on and the commit that branch
 * holds.
 *
 * Nothing contacts a remote and nothing reads a credential. A detached HEAD and
 * a checkout with no usable origin both stop here, before a request exists.
 */
function* resolve(entry: ReplPushEntry, received: ReplPushPlace): Operation<ReplPushResolution> {
  const routed = yield* route(entry, received);
  const placement = routed.registration.placement;
  const origin = yield* destination(routed.registration);

  yield* own(entry, routed);

  const git = yield* entry.git();
  // Serialized with this entry's own native Git, because reading HEAD beside a
  // `<Git.Commit>` of the same repository would describe a moment neither of
  // them is at. The turn is held for these two short reads and released before
  // anything is published: a network round trip never holds it.
  const read = yield* entry.serialize(nativeGitTurn(placement.commonDirectory), function* () {
    const checkout = liveCheckout(git, routed.checkout, received.workingDirectory);
    const branch = yield* currentBranch(checkout.git, checkout.directory);
    if (branch === undefined) {
      throw gitRefusal(PUSH, "unnamed-branch");
    }
    const sourceCommit = yield* resolveCommit(checkout.git, checkout.directory, "HEAD");
    if (sourceCommit === undefined) {
      throw new GitOperationInfrastructureError(
        PUSH,
        "the checkout it ran in did not report the commit its branch holds",
      );
    }
    return { branch, sourceCommit };
  });

  const inputs: GitPushInputs = Object.freeze({
    repository: received.repository,
    remote: PUSH_REMOTE,
    branch: read.branch,
    destinationRef: destinationRefFor(read.branch),
    sourceCommit: read.sourceCommit,
  });
  return Object.freeze({
    checkoutRoot: routed.checkout.root,
    commonDirectory: placement.commonDirectory,
    origin,
    inputs,
  });
}

/**
 * Where this checkout's branch is published to, as this entry can see it now.
 *
 * The locator the entry admitted, held to the fingerprint the Repository
 * identity carries. A checkout that records no usable origin has nowhere to
 * publish to, and one whose origin does not name this repository is not a
 * destination this invocation may use — both before a request exists and
 * before anything is contacted.
 */
function* destination(registration: ReplPlacementRegistration): Operation<string> {
  const origin = yield* registration.origin();
  if (origin === undefined) {
    throw new GitOperationAdmissionError(
      PUSH,
      "the checkout it selected records no usable origin, so there is nowhere for this branch " +
        "to be published to. No credential was read and nothing was contacted",
    );
  }
  if (locatorFingerprint(origin) !== registration.placement.identity.locatorFingerprint) {
    throw new GitOperationAdmissionError(
      PUSH,
      "the origin this checkout records is not the one the Repository in scope was selected " +
        "from, so a branch published to it would go somewhere this entry never authenticated",
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
 *
 * The payload is parsed and held to this entry's own placements before the
 * coordinator publishes it. A payload this build cannot read, or one naming a
 * checkout this entry holds nothing for, takes the fatal path here — so nothing
 * is appended, and a continuation meets today's checkout instead of a record it
 * could never use.
 */
function* publishRequest(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPushPlace,
  received: ReplPushPlace,
  resolved: ReplPushResolution,
  name: string,
): Operation<ReplPushRequestRecord> {
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_PUSH_REQUEST, name },
    function* () {
      const payload = replPushRequestJson({
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
 * not: a live attempt here would publish a request nothing resolved, so it
 * refuses rather than inventing one.
 */
function* restored(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPushPlace,
  name: string,
): Operation<ReplPushRequestRecord> {
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_PUSH_REQUEST, name },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      throw new GitOperationInfrastructureError(
        PUSH,
        "its retained history named a saved publication request at this position and then had " +
          "none, so what this entry asked to publish is unknown",
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
 * is held to them before it is published, and a restored one before it is
 * reconciled. The payload parses, it is this entry's and this invocation's, it
 * asks the question this position is asking, every place it names is one this
 * entry's own registry holds, and the origin it says it asked for is the one
 * the Repository identity in it was fingerprinted from.
 *
 * That last question is asked here rather than in the codec because the digest
 * is this half of the package's: a surface naming no runtime has no synchronous
 * one, and a restored request is reconciled against the origin it recorded
 * rather than against today's — so an edited one would publish this branch to a
 * repository nothing authenticated, and nothing later would notice.
 */
function readback(
  entry: ReplPushEntry,
  invocation: Invocation,
  requested: ReplPushPlace,
  stored: unknown,
): ReplPushRequestRecord {
  const record = parseReplPushRequestRecord(stored);
  if (record === undefined) {
    throw new GitOperationProtocolError(PUSH);
  }
  if (
    record.owner !== invocation.owner ||
    record.site !== invocation.site ||
    !sameReplPushRequest(record.requested, requested)
  ) {
    throw new GitOperationProtocolError(PUSH);
  }
  if (!replPushPlacesHeld(record, placements(entry))) {
    throw new GitOperationProtocolError(PUSH);
  }
  if (
    locatorFingerprint(record.resolved.origin) !==
    record.resolved.inputs.repository.locatorFingerprint
  ) {
    throw new GitOperationProtocolError(PUSH);
  }
  return record;
}

/** Whether a saved question is the question this invocation is asking. */
function sameReplPushRequest(saved: ReplPushPlace, asking: ReplPushPlace): boolean {
  return (
    saved.selectionCheckout === asking.selectionCheckout &&
    saved.commonDirectory === asking.commonDirectory &&
    saved.workingDirectory === asking.workingDirectory &&
    sameRepositoryIdentity(saved.repository, asking.repository)
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
 * A completed outcome comes back before any native work, any resource and any
 * credential: the shared worker replays it without constructing a provider at
 * all. A pending one reaches the live provider below.
 */
function* reconcile(
  entry: ReplPushEntry,
  invocation: Invocation,
  record: ReplPushRequestRecord,
): Operation<GitPushOutcome> {
  const inputs = record.resolved.inputs;
  const expected = pushExpectation(inputs);
  const reconciliation = yield* reconcileOwnedGitHostEffect(
    {
      owner: invocation.owner,
      site: invocation.site,
      request: replPushEffectRequest(inputs),
    },
    {
      provider: () => publication(entry, record),
      validate: (produced: GitHostReconciliationRecord) => {
        if (parseGitPushRecord(produced, expected) === undefined) {
          throw new GitOperationProtocolError(PUSH);
        }
      },
    },
  );
  const outcome = parseGitPushRecord(reconciliation, expected);
  if (outcome === undefined) {
    throw new GitOperationProtocolError(PUSH);
  }
  return outcome;
}

/**
 * The provider that answers this exact publication, built inside the attempt.
 *
 * Reached only by a live attempt, and everything it opens belongs to that
 * attempt's own scope: the scratch transport, the control repository the
 * objects are read through, and the credential session. So what the observation
 * opened is still open when the push performs, and all of it is closed and
 * joined before publication may acknowledge a result.
 *
 * Construction itself reads no credential and no configuration. The session is
 * acquired by the first phase that needs one, which is what keeps a replayed
 * publication — and an attempt that stops before observing — from reading one at
 * all.
 */
function* publication(
  entry: ReplPushEntry,
  record: ReplPushRequestRecord,
): Operation<GitHostProvider> {
  const resolved = record.resolved;
  const inputs = resolved.inputs;
  // The saved checkout, authenticated against this entry's own registry rather
  // than against the filesystem. A root this entry holds no placement for is
  // not somewhere it may publish from, however the record came to name it.
  const routed = entry
    .checkouts()
    .find(
      (checkout) =>
        checkout.registration.placement.checkoutRoot === resolved.checkoutRoot &&
        checkout.registration.placement.commonDirectory === resolved.commonDirectory &&
        sameRepositoryIdentity(checkout.registration.placement.identity, inputs.repository),
    );
  if (routed === undefined) {
    throw new GitOperationAdmissionError(
      PUSH,
      "the checkout its saved request names is not one this entry holds a placement for, so " +
        "there is nowhere for this publication to read its objects from. Nothing was contacted",
    );
  }
  // The slot this publication's checkout belongs to, reacquired before any
  // native use of it. A restored placement took none when it replayed.
  yield* own(entry, routed);

  const git = yield* entry.git();
  // The exact object this request named, which has to still be readable. A
  // missing one fails rather than being fetched: fetching it would manufacture
  // the very thing the publication is about.
  if (!(yield* commitPresent(git, resolved.checkoutRoot, inputs.sourceCommit))) {
    throw new GitOperationInfrastructureError(
      PUSH,
      "the commit its saved request published is no longer readable in that checkout, so this " +
        "publication cannot be reconciled. Nothing was fetched and nothing was contacted",
    );
  }

  const attempt: Scope = yield* useScope();
  const source = objectSourceAt(
    entry.host,
    yield* entry.host.useDirectory(),
    resolved.commonDirectory,
    inputs.repository.objectFormat,
    PUSH,
  );
  // One session for this whole attempt, opened by the first phase that needs
  // it and released with the attempt's own scope.
  const session = lazily(attempt, function* (): Operation<GitAuthenticationSession> {
    return yield* useGitAuthentication(entry.host, resolved.origin);
  });
  return pushProvider(source, resolved.origin, inputs, session);
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
    PUSH,
  );
  const found = registered.find((checkout) => checkout.checkout.root === selected.root);
  if (found === undefined) {
    throw new GitOperationAdmissionError(
      PUSH,
      "the checkout it selected is not one this entry holds a placement for",
    );
  }
  return found;
}

/**
 * Take ownership of the checkout this publication reads from.
 *
 * The managed slot alone. It says which entry owns a managed checkout, which is
 * what a publication needs in order to read its objects; the mutation lease
 * says which entry is changing a repository, and a publication changes none of
 * it. An ambient target has no slot: it is the checkout the person was already
 * standing in.
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

/**
 * The canonical directory this path resolves to, or the path as written.
 *
 * Routing resolves the received directory exactly as recorded local Git does,
 * because a working directory reached through a link is the same place under
 * another name. Only live routing resolves anything: a saved request's roots
 * are authenticated against parsed placements instead.
 */
function* canonical(path: string): Operation<string> {
  try {
    return yield* until(realpath(path));
  } catch {
    return path;
  }
}

/** The public default's own refusal, for a member this descriptor never routes. */
function refusing<T>(element: string): () => Operation<T> {
  // deno-lint-ignore require-yield
  return function* (): Operation<T> {
    throw new GitCompositionProviderError(element);
  };
}

/** The private entry state this execution holds, or the ordinary refusal. */
function held(access: ReplPushAccess): ReplPushEntry {
  const entry = access();
  if (entry === undefined) {
    // The same failure the public Api's own default raises, because that is
    // what this condition is: no publication capability was established for
    // this execution, so nothing performed anything.
    throw new GitCompositionProviderError(PUSH);
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
        PUSH,
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
 * reconcile a branch and a commit this entry never read.
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

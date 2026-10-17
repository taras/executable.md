/**
 * Reconcile external Git-host mutations through {@link reconcileGitHostEffect}.
 * Push and pull-request upsert share this boundary; Issue has its own ordinary
 * middleware and durable envelope, and Prompt keeps its Agent/session contract.
 *
 * A live attempt observes before mutating: perform proven absence once, adopt
 * proven compatible completion, refuse conflict or permanent ambiguity, and report
 * temporary unavailability for authored retry policy. After interruption between
 * remote mutation and local publication, the same external identity lets observation
 * adopt completion without repeating it.
 *
 * Two entrypoints reach that machinery, and they differ only in where the
 * identity comes from and what a live attempt is.
 * {@link reconcileGitHostEffect} derives it from the workflow run and the
 * engine's expansion, and borrows a retained identity where this run already
 * holds a record. {@link reconcileOwnedGitHostEffect} uses exactly the owner
 * and site its caller states, borrows nothing, and runs that caller's provider
 * and validation inside one scope joined before publication. Both share the
 * complete-request parse, the attempt, the decision, the coordinator and the
 * readback; abandoned-history enforcement is checked on either live path before
 * provider work.
 *
 * The complete detached request's digest names the durable operation, so changed
 * inputs cannot consume an earlier answer.
 *
 * {@link GitHost} exposes one frozen, one-use routing request. Public middleware
 * may observe, refuse, narrow policy or delegate; it receives no credential,
 * capability, answer operation or phase evidence, and its return value is ignored.
 * Each phase uses its own descriptor under the stable Api name: names share the
 * middleware chain, while that descriptor owns its private terminal.
 * `withGitHostProvider()` places the selected handler at the terminal end; only
 * its captured continuation inspects the exact request and submits parsed answers.
 * Copied, substituted, reused, stale or unsolicited messages refuse before work.
 *
 * One ordinary durable operation retains request, pre-state, observations, decision
 * and result through the existing pre-persistence gate. Completed replay parses and
 * matches that record without selecting or contacting a provider or appending.
 */

import { createApi } from "@effectionx/context-api";
import { createDurableOperation, serializeError } from "@executablemd/durable-streams";
import type {
  AbandonedRetainedHistory,
  ActivateDurabilityFailure,
  EffectDescription,
  JournalProvenance,
  Json,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
  Workflow,
} from "@executablemd/durable-streams";
import { Err, ensure, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { getExpansion, sourceDescription } from "@executablemd/core";
import { getWorkflowRun } from "@executablemd/workflow";
import { retainedGitHostIdentitiesHere } from "../identities.ts";
import { GIT_HOST_EFFECT } from "./effect-type.ts";
import { claimRetainedGitHostIdentity, exhaustRetainedGitHostIdentities } from "./identities.ts";

/** A request named by a retained record, and how to retire the rest of them. */
interface BorrowedIdentity {
  exhaust(): void;
}
import { GIT_HOST_API, GitHost } from "./api.ts";
import type {
  GitHostApi,
  GitHostCall,
  GitHostPhase,
  GitHostPhaseDetails,
  GitHostProvider,
  GitHostRoutingRequest,
} from "./api.ts";
import {
  GitHostAmbiguousError,
  GitHostConflictError,
  gitHostFailure,
  GitHostProtocolError,
  GitHostProviderError,
  GitHostUnavailableError,
  isGitHostUnavailable,
  isGitHostUnsupportedKind,
} from "./errors.ts";
import {
  type CompleteGitHostEffectRequest,
  type GitHostCompletion,
  type GitHostEffectRequest,
  gitHostReconciliationRecordJson,
  gitHostRequestFingerprint,
  type GitHostObservation,
  type GitHostReconciliationRecord,
  parseCompleteGitHostEffectRequest,
  parseGitHostCompletion,
  parseGitHostObservation,
  parseGitHostReconciliationRecord,
  sameGitHostEffectRequest,
} from "./records.ts";

export { GIT_HOST_EFFECT } from "./effect-type.ts";

/**
 * What one attempt itself decided, kept where no replaceable code can reach it.
 *
 * A Git-host outcome may come from exactly one place: a closed answer the
 * invocation's terminal accepted and parsed. Everything else that can throw on
 * the way — routing middleware, the provider handler, the provider's own body —
 * is the boundary failing, and a boundary failure is not something the run
 * happened to find at the Git host.
 *
 * Which of those a raised error is cannot be decided from the error. A name is
 * a string any middleware can write, and `instanceof` answers "no" for a second
 * loaded copy's genuine failure and "yes" for a look-alike this module never
 * constructed. So authorship is recorded here as the attempt makes it, and read
 * back by object identity: an error is this attempt's own decision only if this
 * attempt is holding that exact object.
 */
interface GitHostSettlement {
  authored?: { readonly failure: Error; readonly outcome: boolean };
}

/**
 * Record a failure as this attempt's own, and hand it back to be thrown.
 *
 * `outcome` says whether the Git host told us this — a conflict, an ambiguity,
 * an unavailability — and therefore whether it belongs in the journal as this
 * effect's failed result. A boundary failure is authored too, so it keeps its
 * exact sentence, but it is not an outcome and is never published.
 */
function author(settlement: GitHostSettlement, failure: Error, outcome: boolean): Error {
  settlement.authored = { failure, outcome };
  return failure;
}

/** Whether `error` is the exact failure this attempt authored, and what it is. */
function authorship(
  settlement: GitHostSettlement,
  error: unknown,
): { readonly outcome: boolean } | undefined {
  const held = settlement.authored;
  return held !== undefined && Object.is(held.failure, error)
    ? { outcome: held.outcome }
    : undefined;
}

/**
 * Install `provider` as the Git host for `operation`, and for nothing outside it.
 *
 * The handler goes at the terminal end of the shared chain, so every other
 * handler is outside it and reaches the provider through it rather than around
 * it. Its `next` is a parameter of this generator: no request carries it, no
 * return value exposes it, and it is the only route to the live invocation's
 * terminal.
 */
export function withGitHostProvider<T>(
  provider: GitHostProvider,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    let installed = true;
    yield* ensure(() => {
      installed = false;
    });
    yield* GitHost.around(
      {
        *route([call], next): Operation<unknown> {
          if (!installed || call.intent !== "route") {
            throw new GitHostProviderError(
              "the selected Git host received something that is not a live routing request",
            );
          }
          // Inspection first, and through the captured continuation: the
          // terminal refuses a copied, reused or stale request here, before any
          // provider work happens.
          const details = phaseDetails(yield* next({ intent: "inspect", routing: call }));
          const answer =
            details.phase === "observe"
              ? yield* provider.observe(details.request)
              : yield* provider.perform(details.request, details.observation);
          yield* next({ intent: "answer", routing: call, answer });
          return undefined;
        },
      },
      { at: "min" },
    );
    return yield* operation;
  });
}

/**
 * The phase details this value describes, or a refusal.
 *
 * Parsed rather than believed. The terminal that produced it belongs to the
 * canonical copy, and this handler may belong to another; what arrives is a
 * value, and reading it as details is this side's decision.
 */
function phaseDetails(value: unknown): GitHostPhaseDetails {
  const phase = readMember(value, "phase");
  const request = parseCompleteGitHostEffectRequest(readMember(value, "request"));
  if (request === undefined) {
    throw new GitHostProviderError("the live Git host invocation described no request");
  }
  if (phase === "observe") {
    return Object.freeze({ phase, request });
  }
  const observation = parseGitHostObservation(readMember(value, "observation"));
  if (phase !== "perform" || observation === undefined) {
    throw new GitHostProviderError("the live Git host invocation described no phase");
  }
  return Object.freeze({ phase, request, observation });
}

function readMember(value: unknown, member: string): unknown {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, member) : undefined;
  } catch {
    return undefined;
  }
}

/** The Effection result this value describes, or `undefined` when it is none. */
function readResult(value: unknown): Result<unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const ok = Reflect.get(value, "ok");
    if (ok === true) {
      return Ok(Reflect.get(value, "value"));
    }
    if (ok !== false) {
      return undefined;
    }
    const error = Reflect.get(value, "error");
    return error instanceof Error ? Err(error) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The closed answer this provider value carries, or a refusal.
 *
 * The failure channel is not a general one. A provider that cannot see the
 * remote says so with an unavailability; one that does not implement this kind
 * says so with a provider refusal, from `observe` and before any remote work.
 * Anything else it puts there is outside the vocabulary it agreed to speak, and
 * reading it as one of the closed conditions would be guessing which.
 *
 * Either way the supplied instance is discarded and this module's own is what
 * travels on, so no provider text, payload or cause reaches a document or the
 * journal.
 */
function closedAnswer<T>(
  phase: GitHostPhase,
  subject: string,
  parse: (value: unknown) => T | undefined,
  value: unknown,
  settlement: GitHostSettlement,
): Result<T> {
  const outcome = readResult(value);
  if (outcome === undefined) {
    throw author(
      settlement,
      new GitHostProtocolError(
        `the Git host provider answered the ${phase} phase with a value that is not a result`,
      ),
      false,
    );
  }
  if (!outcome.ok) {
    if (isGitHostUnavailable(outcome.error)) {
      return Err(author(settlement, new GitHostUnavailableError(), true));
    }
    if (phase === "observe" && isGitHostUnsupportedKind(outcome.error)) {
      return Err(
        author(
          settlement,
          new GitHostProviderError("the selected Git host does not support this effect kind"),
          false,
        ),
      );
    }
    throw author(
      settlement,
      new GitHostProtocolError(
        `the Git host provider failed the ${phase} phase with something other than temporary ` +
          "unavailability or an unsupported effect kind",
      ),
      false,
    );
  }
  const parsed = parse(outcome.value);
  if (parsed === undefined) {
    throw author(
      settlement,
      new GitHostProtocolError(
        `the Git host provider answered the ${phase} phase with a value that is not ${subject}`,
      ),
      false,
    );
  }
  return Ok(parsed);
}

/**
 * This invocation's authoritative terminal: the default of its own descriptor.
 *
 * It answers two private messages and refuses everything else, including the
 * public routing request — arriving here means no provider consumed it, so
 * nothing observed or performed this effect.
 */
function invocationTerminal<T>(
  routing: GitHostRoutingRequest,
  details: GitHostPhaseDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
  settlement: GitHostSettlement,
): {
  route: (call: GitHostCall) => Operation<unknown>;
  accepted: () => Result<T> | undefined;
  close: () => void;
} {
  let state: "available" | "inspected" | "answered" = "available";
  let accepted: Result<T> | undefined;

  function refuse(condition: string): never {
    throw author(settlement, new GitHostProviderError(condition), false);
  }

  return {
    *route(call: GitHostCall): Operation<unknown> {
      if (call.intent === "route") {
        refuse("no Git host provider is installed, so nothing observed or performed this effect");
      }
      // Object identity, not shape: a request rebuilt with the same members
      // describes the same ask and authorizes nothing.
      if (!Object.is(call.routing, routing)) {
        refuse("the live Git host invocation received a copied, substituted or foreign request");
      }
      if (call.intent === "inspect") {
        if (state !== "available") {
          refuse("the live Git host invocation is reused, completed or stale");
        }
        state = "inspected";
        return details;
      }
      if (state !== "inspected") {
        refuse("the live Git host answer is unsolicited, duplicated or stale");
      }
      // Parsed before it is recorded, so a raw payload or a shape this boundary
      // cannot read is refused while there is still nothing to publish.
      accepted = closedAnswer(details.phase, subject, parse, call.answer, settlement);
      state = "answered";
      return undefined;
    },
    accepted(): Result<T> | undefined {
      return accepted;
    },
    close(): void {
      state = "answered";
    },
  };
}

function* gitHostPhase<T>(
  details: GitHostPhaseDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
  settlement: GitHostSettlement,
): Operation<T> {
  const routing: GitHostRoutingRequest = Object.freeze({
    intent: "route",
    phase: details.phase,
    request: details.request,
  });
  const terminal = invocationTerminal(routing, details, subject, parse, settlement);
  // Same stable name, so the shared middleware chain applies; own descriptor,
  // so the chain ends in this invocation's terminal rather than in the public
  // refusing default.
  const invocation = createApi<GitHostApi>(GIT_HOST_API, { route: terminal.route });

  try {
    yield* invocation.operations.route(routing);
  } catch (error) {
    // An answer already accepted is what this phase produced. A provider that
    // threw afterwards, or middleware that threw around it, is reporting on
    // work that already happened.
    if (terminal.accepted() === undefined) {
      throw error;
    }
  } finally {
    terminal.close();
  }

  const answer = terminal.accepted();
  if (answer === undefined) {
    throw author(
      settlement,
      new GitHostProviderError(`the selected Git host did not answer the ${details.phase} phase`),
      false,
    );
  }
  if (!answer.ok) {
    // Authored where it was built, with the publishability its condition earns.
    throw answer.error;
  }
  return answer.value;
}

/**
 * Observe, then decide once.
 *
 * The only path to `perform` is proven absence. Compatibility adopts, conflict
 * and ambiguity refuse, and none of the four branches loops: one attempt asks
 * the provider to mutate at most once, and a second attempt is something a
 * document or explicit middleware asks for, starting again at observation.
 */
function* reconcile(
  request: CompleteGitHostEffectRequest,
  settlement: GitHostSettlement,
): Operation<Json> {
  const observation = yield* gitHostPhase(
    { phase: "observe", request },
    "an observation",
    parseGitHostObservation,
    settlement,
  );

  if (observation.state === "conflict") {
    throw author(settlement, new GitHostConflictError(), true);
  }
  if (observation.state === "ambiguous") {
    throw author(settlement, new GitHostAmbiguousError(), true);
  }
  if (observation.state === "compatible") {
    return gitHostReconciliationRecordJson({
      request,
      preState: observation.preState,
      observations: observation.observations,
      decision: "adopted",
      result: observation.result,
    });
  }

  const completion: GitHostCompletion = yield* gitHostPhase(
    { phase: "perform", request, observation },
    "a completion",
    parseGitHostCompletion,
    settlement,
  );
  return gitHostReconciliationRecordJson({
    request,
    preState: observation.preState,
    observations: completion.observations,
    decision: "performed",
    result: completion.result,
  });
}

/**
 * What this effect's journal entry may say, and who is allowed to say it.
 *
 * A conflict, an ambiguity and an unavailability are what the Git host told
 * this attempt through its terminal, so each is published as the effect's
 * failed result and replays as itself. Everything else that can throw between
 * here and the provider is the boundary failing rather than a finding, and
 * publishing one would let whoever threw write this run's history: a middleware
 * that raises a conflict would retire the effect as conflicted forever, without
 * a Git host ever being asked.
 *
 * So the decision is not read from the error. It is read from this attempt's
 * own record of what it authored, by object identity, which no name and no
 * `instanceof` can imitate. An unauthored throw becomes one fixed, cause-free
 * sentence: nothing the thrower wrote is repeated, and nothing it wrote is
 * journaled, because nothing is journaled at all.
 *
 * Not publishing is only half of it. A live operation that appended nothing
 * would leave the next operation to append at this one's journal position, so
 * an unpublished failure activates the run's existing fail-stop state instead
 * of quietly stepping aside.
 */
function gitHostCoordinator(
  settlement: GitHostSettlement,
  borrowed: BorrowedIdentity | undefined,
): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: DurableResult) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      _journalProvenance: JournalProvenance | undefined,
      abandoned: AbandonedRetainedHistory,
    ): Operation<DurableResult> {
      // Reached only live, and never on replay.
      //
      // Two ways a live attempt here is not this run's to make, and neither is
      // decided by anything a document supplies. `steppedOver` is the engine's
      // own account of the coroutine: it walked away from retained history it
      // never consumed, so records still ahead of it describe work that already
      // happened at a service this journal does not enclose — and doing any of
      // it again is exactly what this boundary exists to prevent. It stays true
      // for every operation after the one that diverged, which is the whole
      // point: guarding only the diverging position leaves every position after
      // it open. `borrowed` says the request was named by a retained record,
      // which cannot be a live request either.
      //
      // The first is the load-bearing one: it holds whether or not the retained
      // identities reached this copy, so erasing or replacing them cannot buy a
      // live effect. Nothing has been executed yet, so the Git host is never
      // reached and nothing is published.
      if (abandoned.steppedOver || borrowed !== undefined) {
        borrowed?.exhaust();
        throw activateFailure(
          new GitHostProviderError(
            "this run walked away from retained history it never consumed, so a Git-host " +
              "effect here would repeat work that already happened outside this journal, or " +
              "perform under a run this execution is not. Nothing was asked of the Git host.",
          ),
        );
      }
      let result: DurableResult;
      try {
        result = { status: "ok", value: yield* execute() };
      } catch (error) {
        const authored = authorship(settlement, error);
        if (authored === undefined) {
          throw activateFailure(
            new GitHostProviderError(
              "the Git host boundary failed before any provider answer was accepted, so this " +
                "effect reached no outcome and what was raised is withheld",
            ),
          );
        }
        if (!authored.outcome) {
          throw activateFailure(errorOf(error));
        }
        result = { status: "err", error: serializeError(errorOf(error)) };
      }
      yield* publish(result);
      return result;
    },
  };
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error("Git host boundary");
}

function* attempt(
  description: EffectDescription,
  borrowed: BorrowedIdentity | undefined,
  execute: (settlement: GitHostSettlement) => Operation<Json>,
): Workflow<unknown> {
  // One settlement per attempt, created here and reachable only from the two
  // halves of this operation. Nothing a document, a provider or a handler holds
  // can put a decision in it.
  const settlement: GitHostSettlement = {};
  return yield createDurableOperation(description, () => execute(settlement), {
    coordinator: gitHostCoordinator(settlement, borrowed),
  });
}

/**
 * The record this retained value is for this request, or the refusal it is not.
 *
 * The same two questions on both entrypoints: the journal's value parses as a
 * reconciliation record, and the request inside it is the request being made
 * now. A retained result is consumed by the effect that produced it rather than
 * by whatever arrives at the same journal position.
 */
function readback(
  retained: unknown,
  request: CompleteGitHostEffectRequest,
): GitHostReconciliationRecord {
  const record = parseGitHostReconciliationRecord(retained);
  if (record === undefined) {
    throw new GitHostProtocolError(
      "the journal holds a value that does not describe a Git-host reconciliation record",
    );
  }
  if (!sameGitHostEffectRequest(record.request, request)) {
    throw new GitHostProtocolError(
      "the journal holds a Git-host reconciliation record for a different request",
    );
  }
  return record;
}

/**
 * The complete request one call makes, or a refusal naming what is missing.
 *
 * The two identity members are the host's and the engine's; the three
 * effect-specific ones are the caller's and are read exactly once, through the
 * same total parse a journal value gets.
 */
function completeRequest(
  runId: string,
  expansionId: string,
  request: unknown,
): CompleteGitHostEffectRequest {
  const complete = parseCompleteGitHostEffectRequest({
    identity: { runId, expansionId },
    kind: readMember(request, "kind"),
    inputs: readMember(request, "inputs"),
    naturalKey: readMember(request, "naturalKey"),
  });
  if (complete === undefined) {
    throw new Error(
      "a Git-host effect needs a non-empty kind and JSON inputs and natural key. A " +
        "request missing one of them, or holding a value JSON cannot express, names no " +
        "Git-host effect.",
    );
  }
  return complete;
}

/**
 * Reconcile one external Git-host effect, and answer with what the run retains.
 *
 * Live, this observes and then adopts, performs or refuses. Replayed, it hands
 * back the record already published without selecting a provider, contacting a
 * Git host, or appending anything — and parses that record, and holds it to the
 * request being made now, before it does.
 */
export function* reconcileGitHostEffect(
  request: GitHostEffectRequest,
): Operation<GitHostReconciliationRecord> {
  const run = yield* getWorkflowRun();
  const expansion = yield* getExpansion();
  // A position this run already retains a record at is named by the identity
  // that record holds; everywhere else by this run's own.
  // The live form first, because what a retained record has to match is the
  // request being made — and the run id is the one member being decided.
  const live = completeRequest(run.runId, expansion.id, request);
  const held = yield* retainedGitHostIdentitiesHere();
  const retainedIdentity = claimRetainedGitHostIdentity(held, live);
  const complete =
    retainedIdentity === undefined
      ? live
      : completeRequest(retainedIdentity, expansion.id, request);
  // Carried into the live path so a name that came from a retained record
  // cannot be the one a live attempt performs under.
  const borrowed: BorrowedIdentity | undefined =
    retainedIdentity === undefined
      ? undefined
      : { exhaust: () => exhaustRetainedGitHostIdentities(held) };
  const description: EffectDescription = {
    type: GIT_HOST_EFFECT,
    name: yield* gitHostRequestFingerprint(complete),
    // Where the authored component asking for this effect was written —
    // diagnostic journal data, never part of the fingerprint, the request, or
    // the reconciliation record.
    ...sourceDescription(expansion.position),
  };

  let retained: unknown;
  try {
    retained = yield* attempt(description, borrowed, (settlement) =>
      reconcile(complete, settlement),
    );
  } catch (error) {
    throw gitHostFailure(error);
  }

  return readback(retained, complete);
}

/**
 * Whose retained history one external effect belongs to, and which invocation
 * inside it this is.
 *
 * Named for what the two members are rather than for the profile that first
 * supplied them, exactly as the Issue envelope beside this names them. A
 * workflow run supplies its run id and the engine's expansion; a REPL entry
 * supplies the owner its host derived and the invocation identity canonical
 * core minted. The `runId`/`expansionId` field spellings in the record and the
 * fingerprint are an encoding of exactly those two, so one reader reads a
 * history written under either profile.
 *
 * Neither member comes from a document, a prop, a Context value, middleware or
 * a provider, for the reason neither ever did: a party that could name the
 * identity could reconcile somebody else's external work.
 */
export interface OwnedGitHostEffect {
  readonly owner: string;
  readonly site: string;
  readonly request: GitHostEffectRequest;
}

/**
 * What one live owned attempt is, as private trusted code.
 *
 * Both members are the caller's own closure rather than anything composable.
 * `provider` is invoked once, inside the attempt's live execution, and the
 * handler it answers with is installed at the terminal end for the whole
 * reconciliation. `validate` is the caller's effect-specific reading of the
 * complete record, run before the coordinator publishes it, so a completion the
 * caller cannot account for is never acknowledged.
 *
 * A completed replay invokes neither. No provider is constructed, no credential
 * is read, nothing is contacted, and the record comes back through the ordinary
 * parsed readback below.
 */
export interface OwnedGitHostLive {
  provider(): Operation<GitHostProvider>;
  validate(record: GitHostReconciliationRecord): void;
}

/**
 * Reconcile one external effect under the identity its owner states.
 *
 * The same complete-request, attempt, decision and readback machinery
 * {@link reconcileGitHostEffect} uses, with two differences and no others. The
 * identity is exactly the supplied owner and site — nothing is derived from a
 * workflow run and no retained identity is borrowed — and the live attempt
 * installs the caller's provider and runs the caller's validation inside one
 * scope that is torn down and joined before publication can acknowledge
 * anything.
 *
 * That ordering is the whole of what this entrypoint adds. A successful
 * outcome, and an ordinary conflict, ambiguity or unavailability the worker
 * authored, are published only after every per-attempt resource has closed: a
 * cleanup that fails replaces what was raised, so the attempt is no longer
 * holding the object it authored and nothing is published at all.
 */
export function* reconcileOwnedGitHostEffect(
  input: OwnedGitHostEffect,
  live: OwnedGitHostLive,
): Operation<GitHostReconciliationRecord> {
  // Read before the first suspension, and through the same total parse a
  // journal value gets. The caller's object is its own, and this operation
  // suspends — hashing the request, and then reconciling it — across which
  // whoever handed it over could still change what it says.
  const owner = ownedMember(input, "owner");
  const site = ownedMember(input, "site");
  const complete = completeRequest(owner, site, readMember(input, "request"));

  const expansion = yield* getExpansion();
  const description: EffectDescription = {
    type: GIT_HOST_EFFECT,
    name: yield* gitHostRequestFingerprint(complete),
    // Where the authored component asking for this effect was written —
    // diagnostic journal data, never part of the fingerprint, the request, or
    // the reconciliation record.
    ...sourceDescription(expansion.position),
  };

  let retained: unknown;
  try {
    // No borrowed identity: this owner and site are the ones supplied, and a
    // name taken from a retained record is not something this entrypoint can
    // be asked to perform under. The abandoned-history guard inside the
    // coordinator still applies.
    retained = yield* attempt(description, undefined, (settlement) =>
      owned(complete, settlement, live),
    );
  } catch (error) {
    throw gitHostFailure(error);
  }

  return readback(retained, complete);
}

/**
 * One live owned attempt: the caller's provider, the shared decision, and the
 * caller's own reading of what it produced.
 *
 * Scoped around the whole reconciliation, so a resource the provider opened to
 * observe is still open when it performs and every one of them is closed before
 * this operation returns to the coordinator that publishes.
 *
 * The attempt's outcome is *held* across that teardown rather than raised
 * through it. Both halves of this are deliberate. A successful outcome and an
 * ordinary conflict, ambiguity or unavailability are only handed on once the
 * scope has finished unwinding, so publication acknowledges work whose
 * resources have actually finished. And teardown that fails raises from the
 * scope instead, before anything held here is handed on: that failure is
 * nobody's authored outcome, so a cleanup that failed publishes neither a
 * success nor a refusal the worker had already decided.
 *
 * Cancellation stays cancellation. A halted scope unwinds without raising, so
 * nothing is held, nothing is re-raised and nothing is published.
 */
function* owned(
  request: CompleteGitHostEffectRequest,
  settlement: GitHostSettlement,
  live: OwnedGitHostLive,
): Operation<Json> {
  let held: Result<Json> | undefined;
  yield* scoped(function* (): Operation<void> {
    const provider = yield* live.provider();
    held = yield* trapped(withGitHostProvider(provider, validated(request, settlement, live)));
  });
  if (held === undefined) {
    throw new GitHostProviderError(
      "this attempt's own scope ended before it reached an answer, so nothing was reconciled",
    );
  }
  if (!held.ok) {
    // The exact object the attempt authored, so the coordinator still reads its
    // authorship by identity and publishes only what the Git host said.
    throw held.error;
  }
  return held.value;
}

/**
 * The attempt's own outcome as a value, so teardown happens before it is acted
 * on.
 *
 * Only a raised failure is caught. Cancellation unwinds a coroutine rather than
 * raising into it, so a halted attempt produces no held outcome at all.
 */
function* trapped(operation: Operation<Json>): Operation<Result<Json>> {
  try {
    return Ok(yield* operation);
  } catch (error) {
    return Err(errorOf(error));
  }
}

function* validated(
  request: CompleteGitHostEffectRequest,
  settlement: GitHostSettlement,
  live: OwnedGitHostLive,
): Operation<Json> {
  const retained = yield* reconcile(request, settlement);
  // Parsed and held to the caller's own expectation here, where there is still
  // nothing published. A completion whose shape this boundary cannot read, or
  // that the caller cannot account for, is the boundary failing: it is authored
  // as this attempt's own non-outcome, so its exact sentence survives and no
  // outcome is written down.
  const record = parseGitHostReconciliationRecord(retained);
  if (record === undefined) {
    throw author(
      settlement,
      new GitHostProtocolError(
        "this attempt produced a value that does not describe a Git-host reconciliation record",
      ),
      false,
    );
  }
  try {
    live.validate(record);
  } catch (error) {
    throw author(settlement, errorOf(error), false);
  }
  return retained;
}

/** One stated identity member, read exactly once, or a refusal naming it. */
function ownedMember(input: unknown, member: "owner" | "site"): string {
  const read = readMember(input, member);
  if (typeof read !== "string" || read === "") {
    throw new Error(
      `reconcileOwnedGitHostEffect() needs a non-empty ${member}. An effect with no ${member} ` +
        "names no retained history, so nothing about it could be reconciled.",
    );
  }
  return read;
}

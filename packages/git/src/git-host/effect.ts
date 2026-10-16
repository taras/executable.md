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
 * Run and expansion identify the effect; the complete detached request's digest
 * names the durable operation so changed inputs cannot consume an earlier answer.
 * Saved identities and abandoned-history enforcement remain checked on the live
 * path before provider work.
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
  AbandonedSavedHistory,
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
import { savedGitHostIdentitiesHere } from "../identities.ts";
import { GIT_HOST_EFFECT } from "./effect-type.ts";
import { claimSavedGitHostIdentity, exhaustSavedGitHostIdentities } from "./identities.ts";

/** A request named by a saved record, and how to retire the rest of them. */
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
      abandoned: AbandonedSavedHistory,
    ): Operation<DurableResult> {
      // Reached only live, and never on replay.
      //
      // Two ways a live attempt here is not this run's to make, and neither is
      // decided by anything a document supplies. `steppedOver` is the engine's
      // own account of the coroutine: it walked away from saved history it
      // never consumed, so records still ahead of it describe work that already
      // happened at a service this journal does not enclose — and doing any of
      // it again is exactly what this boundary exists to prevent. It stays true
      // for every operation after the one that diverged, which is the whole
      // point: guarding only the diverging position leaves every position after
      // it open. `borrowed` says the request was named by a saved record,
      // which cannot be a live request either.
      //
      // The first is the load-bearing one: it holds whether or not the saved
      // identities reached this copy, so erasing or replacing them cannot buy a
      // live effect. Nothing has been executed yet, so the Git host is never
      // reached and nothing is published.
      if (abandoned.steppedOver || borrowed !== undefined) {
        borrowed?.exhaust();
        throw activateFailure(
          new GitHostProviderError(
            "this run walked away from saved history it never consumed, so a Git-host " +
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
  request: CompleteGitHostEffectRequest,
  borrowed: BorrowedIdentity | undefined,
): Workflow<unknown> {
  // One settlement per attempt, created here and reachable only from the two
  // halves of this operation. Nothing a document, a provider or a handler holds
  // can put a decision in it.
  const settlement: GitHostSettlement = {};
  return yield createDurableOperation(description, () => reconcile(request, settlement), {
    coordinator: gitHostCoordinator(settlement, borrowed),
  });
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
  request: GitHostEffectRequest,
): CompleteGitHostEffectRequest {
  const complete = parseCompleteGitHostEffectRequest({
    identity: { runId, expansionId },
    kind: readMember(request, "kind"),
    inputs: readMember(request, "inputs"),
    naturalKey: readMember(request, "naturalKey"),
  });
  if (complete === undefined) {
    throw new Error(
      "reconcileGitHostEffect() needs a non-empty kind and JSON inputs and natural key. A " +
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
  // The live form first, because what a saved record has to match is the
  // request being made — and the run id is the one member being decided.
  const live = completeRequest(run.runId, expansion.id, request);
  const held = yield* savedGitHostIdentitiesHere();
  const savedIdentity = claimSavedGitHostIdentity(held, live);
  const complete =
    savedIdentity === undefined ? live : completeRequest(savedIdentity, expansion.id, request);
  // Carried into the live path so a name that came from a saved record
  // cannot be the one a live attempt performs under.
  const borrowed: BorrowedIdentity | undefined =
    savedIdentity === undefined
      ? undefined
      : { exhaust: () => exhaustSavedGitHostIdentities(held) };
  const description: EffectDescription = {
    type: GIT_HOST_EFFECT,
    name: yield* gitHostRequestFingerprint(complete),
    // Where the authored component asking for this effect was written —
    // diagnostic journal data, never part of the fingerprint, the request, or
    // the reconciliation record.
    ...sourceDescription(expansion.position),
  };

  let saved: unknown;
  try {
    saved = yield* attempt(description, complete, borrowed);
  } catch (error) {
    throw gitHostFailure(error);
  }

  const record = parseGitHostReconciliationRecord(saved);
  if (record === undefined) {
    throw new GitHostProtocolError(
      "the journal holds a value that does not describe a Git-host reconciliation record",
    );
  }
  if (!sameGitHostEffectRequest(record.request, complete)) {
    throw new GitHostProtocolError(
      "the journal holds a Git-host reconciliation record for a different request",
    );
  }
  return record;
}

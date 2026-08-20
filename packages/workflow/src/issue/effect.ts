/**
 * One reconciliation for every external Issue effect.
 *
 * An issue provider — the external service that owns a collection of issues —
 * holds state this repository's SQLite transaction cannot enclose. So creation
 * cannot commit "the tracker changed" and "the journal says so" together, and
 * this is the answer to what an attempt does when it cannot tell whether the
 * previous one already succeeded.
 *
 * One live attempt always observes before it mutates:
 *
 * - proven absence is performed, once;
 * - a proven compatible completion is adopted, and nothing is performed;
 * - conflict is refused;
 * - permanent ambiguity is refused; and
 * - temporary unavailability fails as itself, so the document's own structure
 *   or explicit middleware — not this engine — decides on a retry.
 *
 * That ordering is what survives the gap this exists for. If a provider
 * accepted the creation and the host died before the local result was
 * published, the next execution finds no journal entry, observes under the same
 * external identity, recognizes its own completion and adopts it. The issue is
 * created once. Removing the observation, or adopting anything weaker than a
 * proven compatible completion, is what would make it twice.
 *
 * ## Why this is not a kind inside the Git-host boundary
 *
 * An issue provider does not necessarily own a Git repository. Atlassian issue
 * tracking owns none, so an Atlassian issue cannot truthfully execute or
 * persist as a `git_host_effect`. What is reused from §10.2 is the algorithm
 * above and the one-surface authority rule; what is Issue-owned — and therefore
 * an Issue compatibility boundary — is the stable API name, the normalized
 * request, the provider identity, the natural key, the result and the durable
 * effect type.
 *
 * ## Identity, and what may name it
 *
 * The external identity is the run and the expansion — derived here, from the
 * host-established `getWorkflowRun()` and the engine's own `getExpansion()` —
 * together with the canonical target the context resolved. Neither the
 * document, the context, middleware nor the provider supplies the first two,
 * because a party that could name the identity could name someone else's
 * completion.
 */

import { createApi } from "@effectionx/context-api";
import { Err, ensure, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import {
  createDurableOperation,
  serializeError,
  type AbandonedRetainedHistory,
  type ActivateDurabilityFailure,
  type EffectDescription,
  type JournalProvenance,
  type Json,
  type LiveDurableOperationCoordinator,
  type Result as DurableResult,
  type Workflow,
} from "@executablemd/durable-streams";
import { getExpansion } from "@executablemd/core";
import { getWorkflowRun, retainedIssueIdentitiesHere } from "../run.ts";
import { exhaustRetainedIssueIdentities, claimRetainedIssueIdentity } from "./identities.ts";
import { ISSUE_EFFECT } from "./effect-type.ts";
import { IssueRouting, ISSUE_API } from "./api.ts";
import type {
  IssueApi,
  IssueCall,
  IssuePhase,
  IssuePhaseDetails,
  IssueProvider,
  IssueRoutingRequest,
} from "./api.ts";
import {
  IssueAmbiguousError,
  IssueConflictError,
  IssueProtocolError,
  IssueProviderError,
  IssueUnavailableError,
  isIssueRefused,
  isIssueUnavailable,
  issueFailure,
} from "./errors.ts";
import {
  completeIssueRequestJson,
  issueNaturalKey,
  issueNaturalKeyJson,
  issueReconciliationRecordJson,
  issueRequestFingerprint,
  parseCompleteIssueRequest,
  parseIssueCompletion,
  parseIssueObservation,
  parseIssueReconciliationRecord,
  sameIssueRequest,
  type CompleteIssueRequest,
  type IssueCompletion,
  type IssueReconciliationRecord,
} from "./records.ts";

export { ISSUE_EFFECT } from "./effect-type.ts";

/** What one caller asks for, apart from where it sits. */
export interface IssueEffectRequest {
  readonly provider: string;
  readonly target: string;
  readonly inputs: Json;
}

/** A name a retained record lent, and the prefix it came out of. */
interface BorrowedIdentity {
  exhaust(): void;
}

/**
 * What one attempt itself decided, kept where no replaceable code can reach it.
 *
 * An Issue outcome may come from exactly one place: a closed answer the
 * invocation's terminal accepted and parsed. Everything else that can throw on
 * the way — routing middleware, the provider handler, the provider's own body —
 * is the boundary failing, and a boundary failure is not something the run
 * happened to find at a provider.
 *
 * Which of those a raised error is cannot be decided from the error. A name is
 * a string any middleware can write, and `instanceof` answers "no" for a second
 * loaded copy's genuine failure and "yes" for a look-alike this module never
 * constructed. So authorship is recorded here as the attempt makes it, and read
 * back by object identity.
 */
interface IssueSettlement {
  authored?: { readonly failure: Error; readonly outcome: boolean };
}

function author(settlement: IssueSettlement, failure: Error, outcome: boolean): Error {
  settlement.authored = { failure, outcome };
  return failure;
}

function authorship(
  settlement: IssueSettlement,
  error: unknown,
): { readonly outcome: boolean } | undefined {
  const held = settlement.authored;
  return held !== undefined && Object.is(held.failure, error)
    ? { outcome: held.outcome }
    : undefined;
}

/**
 * Install `provider` for one discriminator, for `operation` and nothing outside.
 *
 * The handler goes at the terminal end of the shared chain, so every other
 * handler is outside it and reaches the provider through it rather than around
 * it. A request whose resolved provider is another discriminator is delegated
 * untouched, which is what lets several providers be installed at once without
 * any of them searching for work.
 */
export function withIssueProvider<T>(
  discriminator: string,
  provider: IssueProvider,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    yield* useIssueProvider(discriminator, provider);
    return yield* operation;
  });
}

/**
 * Install `provider` for one discriminator, for the current scope and below.
 *
 * The form a host uses, where the scope that owns the providers is the scope
 * that owns the run rather than one wrapped around a single operation. Several
 * of these compose: each answers only its own discriminator, so installing
 * GitHub and Atlassian side by side needs no coordination between them.
 */
export function* useIssueProvider(discriminator: string, provider: IssueProvider): Operation<void> {
  {
    let installed = true;
    yield* ensure(() => {
      installed = false;
    });
    yield* IssueRouting.around(
      {
        *route([call], next): Operation<unknown> {
          // A private message on its way to the invocation's own terminal,
          // which is the only thing that can accept one. Several providers may
          // be installed, so one provider's `inspect` and `answer` travel
          // through the handlers installed beneath it, and they pass through
          // untouched: the terminal decides by object identity, and a handler
          // that read or rewrote one could not make it mean anything else.
          if (call.intent !== "route") {
            return yield* next(call);
          }
          // Not this provider's request, or this handler's scope has ended.
          // Delegating untouched is the whole of what either does: it never
          // inspects, never answers, and never decides that somebody else
          // should have the request.
          if (!installed || call.request.provider !== discriminator) {
            return yield* next(call);
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
  }
}

/**
 * The phase details this value describes, or a refusal.
 *
 * Parsed rather than believed. The terminal that produced it belongs to the
 * canonical copy, and this handler may belong to another; what arrives is a
 * value, and reading it as details is this side's decision.
 */
function phaseDetails(value: unknown): IssuePhaseDetails {
  const phase = readMember(value, "phase");
  const request = parseCompleteIssueRequest(readMember(value, "request"));
  if (request === undefined) {
    throw new IssueProviderError("the live issue invocation described no request");
  }
  if (phase === "observe") {
    return Object.freeze({ phase, request });
  }
  const observation = parseIssueObservation(readMember(value, "observation"));
  if (phase !== "perform" || observation === undefined) {
    throw new IssueProviderError("the live issue invocation described no phase");
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
 * The failure channel is not a general one. A provider that cannot see its
 * service says so with an unavailability; one that will not act on this target
 * says so with a provider refusal, from `observe` and before any remote work.
 * Anything else it puts there is outside the vocabulary it agreed to speak.
 *
 * Either way the supplied instance is discarded and this module's own is what
 * travels on, so no provider text, payload or cause reaches a document or the
 * journal.
 */
function closedAnswer<T>(
  phase: IssuePhase,
  subject: string,
  parse: (value: unknown) => T | undefined,
  value: unknown,
  settlement: IssueSettlement,
): Result<T> {
  const outcome = readResult(value);
  if (outcome === undefined) {
    throw author(
      settlement,
      new IssueProtocolError(
        `the issue provider answered the ${phase} phase with a value that is not a result`,
      ),
      false,
    );
  }
  if (!outcome.ok) {
    if (isIssueUnavailable(outcome.error)) {
      return Err(author(settlement, new IssueUnavailableError(), true));
    }
    if (phase === "observe" && isIssueRefused(outcome.error)) {
      return Err(
        author(
          settlement,
          new IssueProviderError("the selected issue provider will not act on this target"),
          false,
        ),
      );
    }
    throw author(
      settlement,
      new IssueProtocolError(
        `the issue provider failed the ${phase} phase with something other than temporary ` +
          "unavailability or a refused target",
      ),
      false,
    );
  }
  const parsed = parse(outcome.value);
  if (parsed === undefined) {
    throw author(
      settlement,
      new IssueProtocolError(
        `the issue provider answered the ${phase} phase with a value that is not ${subject}`,
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
  routing: IssueRoutingRequest,
  details: IssuePhaseDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
  settlement: IssueSettlement,
): {
  route: (call: IssueCall) => Operation<unknown>;
  accepted: () => Result<T> | undefined;
  close: () => void;
} {
  let state: "available" | "inspected" | "answered" = "available";
  let accepted: Result<T> | undefined;

  function refuse(condition: string): never {
    throw author(settlement, new IssueProviderError(condition), false);
  }

  return {
    *route(call: IssueCall): Operation<unknown> {
      if (call.intent === "route") {
        refuse(
          "no issue provider is registered for the resolved discriminator, so nothing " +
            "observed or performed this effect",
        );
      }
      // Object identity, not shape: a request rebuilt with the same members
      // describes the same ask and authorizes nothing.
      if (!Object.is(call.routing, routing)) {
        refuse("the live issue invocation received a copied, substituted or foreign request");
      }
      if (call.intent === "inspect") {
        if (state !== "available") {
          refuse("the live issue invocation is reused, completed or stale");
        }
        state = "inspected";
        return details;
      }
      if (state !== "inspected") {
        refuse("the live issue answer is unsolicited, duplicated or stale");
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

function* issuePhase<T>(
  details: IssuePhaseDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
  settlement: IssueSettlement,
): Operation<T> {
  const routing: IssueRoutingRequest = Object.freeze({
    intent: "route",
    phase: details.phase,
    request: details.request,
  });
  const terminal = invocationTerminal(routing, details, subject, parse, settlement);
  // Same stable name, so the shared middleware chain applies; own descriptor,
  // so the chain ends in this invocation's terminal rather than in the public
  // refusing default.
  const invocation = createApi<IssueApi>(ISSUE_API, { route: terminal.route });

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
      new IssueProviderError(
        `the selected issue provider did not answer the ${details.phase} phase`,
      ),
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
function* reconcile(request: CompleteIssueRequest, settlement: IssueSettlement): Operation<Json> {
  const observation = yield* issuePhase(
    { phase: "observe", request },
    "an observation",
    parseIssueObservation,
    settlement,
  );

  if (observation.state === "conflict") {
    throw author(settlement, new IssueConflictError(), true);
  }
  if (observation.state === "ambiguous") {
    throw author(settlement, new IssueAmbiguousError(), true);
  }
  if (observation.state === "compatible") {
    return issueReconciliationRecordJson({
      request,
      preState: observation.preState,
      observations: observation.observations,
      decision: "adopted",
      result: observation.result,
    });
  }

  const completion: IssueCompletion = yield* issuePhase(
    { phase: "perform", request, observation },
    "a completion",
    parseIssueCompletion,
    settlement,
  );
  return issueReconciliationRecordJson({
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
 * A conflict, an ambiguity and an unavailability are what the provider told
 * this attempt through its terminal, so each is published as the effect's
 * failed result and replays as itself. Everything else that can throw between
 * here and the provider is the boundary failing rather than a finding, and
 * publishing one would let whoever threw write this run's history.
 *
 * So the decision is not read from the error. It is read from this attempt's
 * own record of what it authored, by object identity, which no name and no
 * `instanceof` can imitate.
 */
function issueCoordinator(
  settlement: IssueSettlement,
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
      // Reached only live, and never on replay. The same two conditions the
      // Git-host boundary refuses, for the same reason: a run that walked away
      // from retained history it never consumed would repeat work that already
      // happened at a service this journal does not enclose, and a request
      // named by a retained record cannot be a live request either.
      if (abandoned.steppedOver || borrowed !== undefined) {
        borrowed?.exhaust();
        throw activateFailure(
          new IssueProviderError(
            "this run walked away from retained history it never consumed, so an issue " +
              "effect here would repeat work that already happened outside this journal, or " +
              "perform under a run this execution is not. Nothing was asked of any provider.",
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
            new IssueProviderError(
              "the issue boundary failed before any provider answer was accepted, so this " +
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
  return value instanceof Error ? value : new Error("issue boundary");
}

function* attempt(
  description: EffectDescription,
  request: CompleteIssueRequest,
  borrowed: BorrowedIdentity | undefined,
): Workflow<unknown> {
  // One settlement per attempt, created here and reachable only from the two
  // halves of this operation. Nothing a document, a provider or a handler holds
  // can put a decision in it.
  const settlement: IssueSettlement = {};
  return yield createDurableOperation(description, () => reconcile(request, settlement), {
    coordinator: issueCoordinator(settlement, borrowed),
  });
}

/**
 * The complete request one call makes, or a refusal naming what is missing.
 *
 * The two identity members are the host's and the engine's; the destination and
 * the inputs are the caller's and are read exactly once, through the same total
 * parse a journal value gets.
 */
function completeRequest(
  runId: string,
  expansionId: string,
  request: IssueEffectRequest,
): CompleteIssueRequest {
  const identity = { runId, expansionId };
  const complete = parseCompleteIssueRequest({
    identity,
    provider: readMember(request, "provider"),
    target: readMember(request, "target"),
    inputs: readMember(request, "inputs"),
    naturalKey: issueNaturalKeyJson(
      issueNaturalKey(identity, typeof request.target === "string" ? request.target : ""),
    ),
  });
  if (complete === undefined) {
    throw new Error(
      "reconcileIssueEffect() needs a non-empty provider and target and JSON inputs. A " +
        "request missing one of them, or holding a value JSON cannot express, names no issue " +
        "effect.",
    );
  }
  return complete;
}

/**
 * Reconcile one external Issue effect, and answer with what the run retains.
 *
 * Live, this observes and then adopts, performs or refuses. Replayed, it hands
 * back the record already published without resolving a provider, contacting
 * one, or appending anything — and parses that record, and holds it to the
 * request being made now, before it does.
 */
export function* reconcileIssueEffect(
  request: IssueEffectRequest,
): Operation<IssueReconciliationRecord> {
  const run = yield* getWorkflowRun();
  const expansion = yield* getExpansion();
  // A position this run already retains a record at is named by the identity
  // that record holds; everywhere else by this run's own.
  const live = completeRequest(run.runId, expansion.id, request);
  const held = yield* retainedIssueIdentitiesHere();
  const retainedIdentity = claimRetainedIssueIdentity(held, live);
  const complete =
    retainedIdentity === undefined
      ? live
      : completeRequest(retainedIdentity, expansion.id, request);
  // Carried into the live path so a name that came from a retained record
  // cannot be the one a live attempt performs under.
  const borrowed: BorrowedIdentity | undefined =
    retainedIdentity === undefined
      ? undefined
      : { exhaust: () => exhaustRetainedIssueIdentities(held) };
  const description: EffectDescription = {
    type: ISSUE_EFFECT,
    name: yield* issueRequestFingerprint(complete),
  };

  let retained: unknown;
  try {
    retained = yield* attempt(description, complete, borrowed);
  } catch (error) {
    throw issueFailure(error);
  }

  const record = parseIssueReconciliationRecord(retained);
  if (record === undefined) {
    throw new IssueProtocolError(
      "the journal holds a value that does not describe an issue reconciliation record",
    );
  }
  if (!sameIssueRequest(record.request, complete)) {
    throw new IssueProtocolError(
      "the journal holds an issue reconciliation record for a different request",
    );
  }
  return record;
}

export { completeIssueRequestJson };

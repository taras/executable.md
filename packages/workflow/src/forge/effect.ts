/**
 * One shared reconciliation for every external forge effect.
 *
 * A forge — the service that holds branches, pull requests and issues — owns
 * state this repository's SQLite transaction cannot enclose. Push, pull request
 * and issue creation therefore cannot commit "the remote changed" and "the
 * journal says so" together, and each of them would otherwise have to invent
 * its own answer to the same question: what does an attempt do when it cannot
 * tell whether the previous one already succeeded?
 *
 * They do not invent it. Every external effect runs through
 * {@link reconcileForgeEffect}, and one live attempt always observes before it
 * mutates:
 *
 * - proven absence is performed, once;
 * - a proven compatible completion is adopted, and nothing is performed;
 * - conflict is refused;
 * - permanent ambiguity is refused; and
 * - temporary unavailability fails as itself, so the document's own structure
 *   or explicit middleware — not this engine — decides on a retry.
 *
 * That ordering is what survives the gap this issue exists for. If a remote
 * accepted the mutation and the host died before the local result was
 * published, the next execution finds no journal entry, observes under the same
 * external identity, recognizes its own completion and adopts it. The remote is
 * mutated once. Removing the observation, or adopting anything weaker than a
 * proven compatible completion, is what would make it twice.
 *
 * ## Identity, and what may name it
 *
 * The external identity is the run and the expansion — derived here, from the
 * host-established `getWorkflowRun()` and the engine's own `getExpansion()`.
 * Neither the document nor the provider supplies either member, because a party
 * that could name the identity could name someone else's completion.
 *
 * The durable operation is named by a digest of the complete detached request
 * instead. Identity is where the effect *is*; the fingerprint is what it *asks*,
 * and separating them is what stops a changed input from consuming the retained
 * result of a different question at the same journal position.
 *
 * ## What completes a phase
 *
 * Provider selection is contextual and replaceable, and it is not authority.
 * Each phase mints a one-use route and a separate opaque credential, sends only
 * the route through the contextual call, and puts the phase's evidence and its
 * answer behind a capability that accepts nothing but the credential. The
 * selected provider consumes the route and invokes that capability directly.
 * Middleware can route or refuse a phase; it cannot observe one, answer one, or
 * replace an answer already recorded. A short circuit, a forged return, a
 * substituted selection and a reused request all complete nothing, and a throw
 * after a real provider answered cannot take that answer away.
 *
 * ## What is durable
 *
 * The record — the request, the pre-state, the observations, the decision and
 * the result — is the value of one ordinary durable operation, published
 * through the existing stream and its existing pre-persistence gate. There is
 * no side journal, no payload cache and no schema change. A completed record
 * replays without installing or contacting a provider at all, and is parsed and
 * held to the current request before it is handed back.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { createDurableOperation, serializeError } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  EffectDescription,
  Json,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
  Workflow,
} from "@executablemd/durable-streams";
import { Err, ensure, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { getExpansion } from "@executablemd/core";
import { getWorkflowRun } from "../run.ts";
import { Forge } from "./api.ts";
import type { ForgeProvider } from "./api.ts";
import {
  ForgeAmbiguousError,
  ForgeConflictError,
  forgeFailure,
  ForgeProtocolError,
  ForgeProviderError,
  ForgeUnavailableError,
  isForgeAuthorityFailure,
  isForgeUnavailable,
} from "./errors.ts";
import {
  type CompleteForgeEffectRequest,
  type ForgeCompletion,
  type ForgeEffectRequest,
  forgeReconciliationRecordJson,
  forgeRequestFingerprint,
  type ForgeObservation,
  type ForgeReconciliationRecord,
  parseCompleteForgeEffectRequest,
  parseForgeCompletion,
  parseForgeObservation,
  parseForgeReconciliationRecord,
  sameCompleteForgeEffectRequest,
} from "./records.ts";

/** The durable type every external forge effect is journaled under. */
export const FORGE_EFFECT = "forge_effect";

const FORGE_INVOCATION_API = "executablemd.workflow.forge.invocation";

type ForgePhase = "observe" | "perform";

/**
 * What one phase is entitled to know, read from the capability rather than from
 * the routed request.
 *
 * Which provider method runs is decided here, so middleware that rewrote the
 * contextual request cannot turn an observation into a mutation.
 */
type ForgeInvocationDetails =
  | { readonly phase: "observe"; readonly request: CompleteForgeEffectRequest }
  | {
      readonly phase: "perform";
      readonly request: CompleteForgeEffectRequest;
      readonly observation: ForgeObservation;
    };

interface ForgeInvocationCapability {
  inspect(credential: object): Operation<ForgeInvocationDetails>;
  answer(credential: object, answer: unknown): Operation<void>;
}

interface StartRequest {
  readonly type: "start";
  readonly route: object;
  readonly invocation: ForgeInvocationCapability;
}

interface ForgeInvocationApi {
  coordinate(request: StartRequest): Operation<void>;
}

interface ProviderSelection {
  readonly route: object;
  readonly credential: object;
}

const ForgeInvocation: Api<ForgeInvocationApi> = createApi<ForgeInvocationApi>(
  FORGE_INVOCATION_API,
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<void> {
      throw new ForgeProviderError("no forge provider accepted this live invocation");
    },
  },
);

function providerSelection(value: object | undefined): ProviderSelection {
  const route = value === undefined ? undefined : Reflect.get(value, "route");
  const credential = value === undefined ? undefined : Reflect.get(value, "credential");
  if (
    typeof route !== "object" ||
    route === null ||
    typeof credential !== "object" ||
    credential === null
  ) {
    throw new ForgeProviderError("the selected forge provider is missing, foreign, or substituted");
  }
  return { route, credential };
}

/**
 * Install `provider` as the forge for `operation`, and for nothing outside it.
 *
 * The installation owns two things at once. The selection handler mints a fresh
 * route and credential per phase and remembers the pairing privately; the
 * invocation handler is the only party that can turn a route back into its
 * credential, and it consumes the pairing when it does. A route that arrives
 * twice, a route this scope never minted, and any route at all after the scope
 * has ended are the same refusal.
 */
export function withForgeProvider<T>(
  provider: ForgeProvider,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const registrations = new WeakMap<object, object>();
    let registrationOpen = true;
    yield* ensure(() => {
      registrationOpen = false;
    });
    yield* Forge.around(
      {
        provider(): object {
          const route = Object.freeze({});
          const credential = Object.freeze({});
          registrations.set(route, credential);
          return Object.freeze({ route, credential });
        },
      },
      { at: "min" },
    );
    yield* ForgeInvocation.around(
      {
        *coordinate([request]): Operation<void> {
          const credential = registrations.get(request.route);
          registrations.delete(request.route);
          if (!registrationOpen || request.type !== "start" || credential === undefined) {
            throw new ForgeProviderError(
              "the selected forge provider is missing, foreign, reused, completed, or stale",
            );
          }

          const details = yield* request.invocation.inspect(credential);
          const answer =
            details.phase === "observe"
              ? yield* provider.observe(details.request)
              : yield* provider.perform(details.request, details.observation);
          yield* request.invocation.answer(credential, answer);
        },
      },
      { at: "min" },
    );
    return yield* operation;
  });
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
 * remote says so with {@link ForgeUnavailableError}; anything else it puts
 * there is outside the vocabulary it agreed to speak, and reading it as one of
 * the five conditions would guess which. A thrown error is a different matter
 * and never arrives here — it stays an ordinary failure of the operation, which
 * is how cancellation stays cancellation.
 */
function closedAnswer<T>(
  phase: ForgePhase,
  subject: string,
  parse: (value: unknown) => T | undefined,
  value: unknown,
): Result<T> {
  const outcome = readResult(value);
  if (outcome === undefined) {
    throw new ForgeProtocolError(
      `the forge provider answered the ${phase} phase with a value that is not a result`,
    );
  }
  if (!outcome.ok) {
    if (!isForgeUnavailable(outcome.error)) {
      throw new ForgeProtocolError(
        `the forge provider failed the ${phase} phase with something other than temporary ` +
          "unavailability",
      );
    }
    return Err(new ForgeUnavailableError());
  }
  const parsed = parse(outcome.value);
  if (parsed === undefined) {
    throw new ForgeProtocolError(
      `the forge provider answered the ${phase} phase with a value that is not ${subject}`,
    );
  }
  return Ok(parsed);
}

function invocationCapability<T>(
  credential: object,
  details: ForgeInvocationDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
): {
  capability: ForgeInvocationCapability;
  authoritativeAnswer: () => Result<T> | undefined;
  close: () => void;
} {
  let state: "available" | "active" | "complete" = "available";
  let answered: Result<T> | undefined;

  function requireCredential(candidate: object): void {
    if (candidate !== credential) {
      throw new ForgeProviderError("the live forge invocation has foreign authority");
    }
  }

  return {
    capability: Object.freeze({
      *inspect(candidate: object): Operation<ForgeInvocationDetails> {
        requireCredential(candidate);
        if (state !== "available") {
          throw new ForgeProviderError(
            "the live forge invocation is missing, reused, completed, or stale",
          );
        }
        state = "active";
        return details;
      },
      *answer(candidate: object, answer: unknown): Operation<void> {
        requireCredential(candidate);
        if (state !== "active") {
          throw new ForgeProviderError("the live forge invocation is completed or stale");
        }
        // Parsed before it is recorded, so a raw payload or a shape this
        // boundary cannot read is refused while there is still nothing to
        // publish.
        answered = closedAnswer(details.phase, subject, parse, answer);
        state = "complete";
      },
    }),
    authoritativeAnswer(): Result<T> | undefined {
      return answered;
    },
    close(): void {
      state = "complete";
    },
  };
}

function* coordinatedAnswer<T>(
  details: ForgeInvocationDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
): Operation<Result<T> | undefined> {
  const selection = providerSelection(yield* Forge.operations.provider);
  const invocation = invocationCapability(selection.credential, details, subject, parse);
  try {
    yield* ForgeInvocation.operations.coordinate({
      type: "start",
      route: selection.route,
      invocation: invocation.capability,
    });
    return invocation.authoritativeAnswer();
  } catch (error) {
    // An authoritative answer already recorded is what this phase produced. A
    // provider that threw afterwards, or middleware that threw around it, is
    // reporting on work that already happened.
    const answer = invocation.authoritativeAnswer();
    if (answer !== undefined) {
      return answer;
    }
    throw error;
  } finally {
    invocation.close();
  }
}

function* forgePhase<T>(
  details: ForgeInvocationDetails,
  subject: string,
  parse: (value: unknown) => T | undefined,
): Operation<T> {
  const answer = yield* coordinatedAnswer(details, subject, parse);
  if (answer === undefined) {
    throw new ForgeProviderError(
      `the selected forge provider did not answer the ${details.phase} phase`,
    );
  }
  if (!answer.ok) {
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
function* reconcile(request: CompleteForgeEffectRequest): Operation<Json> {
  const observation = yield* forgePhase(
    { phase: "observe", request },
    "an observation",
    parseForgeObservation,
  );

  if (observation.state === "conflict") {
    throw new ForgeConflictError();
  }
  if (observation.state === "ambiguous") {
    throw new ForgeAmbiguousError();
  }
  if (observation.state === "compatible") {
    return forgeReconciliationRecordJson({
      request,
      preState: observation.preState,
      observations: observation.observations,
      decision: "adopted",
      result: observation.result,
    });
  }

  const completion: ForgeCompletion = yield* forgePhase(
    { phase: "perform", request, observation },
    "a completion",
    parseForgeCompletion,
  );
  return forgeReconciliationRecordJson({
    request,
    preState: observation.preState,
    observations: completion.observations,
    decision: "performed",
    result: completion.result,
  });
}

/**
 * The ordinary live path, with one distinction the default coordinator cannot
 * make.
 *
 * A conflict, an ambiguity and an unavailability are what this effect found, so
 * each is published as the effect's failed result and replays as itself. A
 * missing, foreign, substituted or reused provider selection, and an answer
 * this boundary cannot read, are not findings at all: no provider spoke, so
 * there is no outcome to record, and recording one would hold every later
 * execution of this run to a failure that describes the host rather than the
 * forge.
 *
 * Not publishing is only half of it. A live operation that appended nothing
 * would leave the next operation to append at this one's journal position, so
 * the attempt activates the run's existing fail-stop state instead of quietly
 * stepping aside.
 */
const forgeCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: DurableResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<DurableResult> {
    let result: DurableResult;
    try {
      result = { status: "ok", value: yield* execute() };
    } catch (error) {
      if (isForgeAuthorityFailure(error)) {
        throw activateFailure(error);
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      result = { status: "err", error: serializeError(failure) };
    }
    yield* publish(result);
    return result;
  },
};

function* attempt(
  description: EffectDescription,
  request: CompleteForgeEffectRequest,
): Workflow<unknown> {
  return yield createDurableOperation(description, () => reconcile(request), {
    coordinator: forgeCoordinator,
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
  request: ForgeEffectRequest,
): CompleteForgeEffectRequest {
  const complete = parseCompleteForgeEffectRequest({
    identity: { runId, expansionId },
    kind: readMember(request, "kind"),
    inputs: readMember(request, "inputs"),
    naturalKey: readMember(request, "naturalKey"),
  });
  if (complete === undefined) {
    throw new Error(
      "reconcileForgeEffect() needs a non-empty kind and JSON inputs and natural key. A " +
        "request missing one of them, or holding a value JSON cannot express, names no " +
        "external effect.",
    );
  }
  return complete;
}

function readMember(request: ForgeEffectRequest, member: string): unknown {
  try {
    return Reflect.get(Object(request), member);
  } catch {
    return undefined;
  }
}

/**
 * Reconcile one external forge effect, and answer with what the run retains.
 *
 * Live, this observes and then adopts, performs or refuses. Replayed, it hands
 * back the record already published without selecting a provider, contacting a
 * forge, or appending anything — and parses that record, and holds it to the
 * request being made now, before it does.
 */
export function* reconcileForgeEffect(
  request: ForgeEffectRequest,
): Operation<ForgeReconciliationRecord> {
  const run = yield* getWorkflowRun();
  const expansion = yield* getExpansion();
  const complete = completeRequest(run.runId, expansion.id, request);
  const description: EffectDescription = {
    type: FORGE_EFFECT,
    name: yield* forgeRequestFingerprint(complete),
  };

  let retained: unknown;
  try {
    retained = yield* attempt(description, complete);
  } catch (error) {
    throw forgeFailure(error);
  }

  const record = parseForgeReconciliationRecord(retained);
  if (record === undefined) {
    throw new ForgeProtocolError(
      "the journal holds a value that does not describe a forge reconciliation record",
    );
  }
  if (!sameCompleteForgeEffectRequest(record.request, complete)) {
    throw new ForgeProtocolError(
      "the journal holds a forge reconciliation record for a different request",
    );
  }
  return record;
}

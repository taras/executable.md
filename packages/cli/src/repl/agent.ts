/**
 * What this process knows about Agent turns that the Journal does not yet.
 *
 * A `<Prompt>` is durable work: it returns only once its provider turn has
 * settled and its ordinary `agent_prompt` record has appended, and that record
 * is the only retained truth about it. Between those two moments there is a
 * turn nobody can read — queued, then streaming, then finished but unpublished
 * — and a REPL that showed nothing until the append would show nothing for the
 * whole of the interesting part.
 *
 * So this observes. It installs ordinary middleware around `Agent.prompt()` and
 * `Agent.requestPermission()` inside the execution, publishes an immutable
 * reading of each turn as the provider's own events go past, and removes that
 * reading at the exact moment the durable record replaces it. Nothing here is
 * retained, nothing here is a Core Api member, and nothing here is visible to a
 * document.
 *
 * ## The observer must not become the consumer
 *
 * `Agent.prompt()` hands back a *cold* stream, and whoever subscribes owns the
 * turn. This wraps that stream rather than subscribing to it: `<Prompt>` stays
 * the one subscriber, the one owner of provider cancellation, and the one
 * reader of the final value. Each event object travels through untouched and
 * unfrozen — what is frozen is the separate reading copied out of it — and an
 * observation failure is never allowed to become a Prompt failure.
 *
 * ## Correlation is the canonical publication, not a resemblance or a queue
 *
 * Two `<Spawn>` children may run identical prompts against identical responses
 * and settle in either order, so nothing about a turn's *content* identifies
 * it: not its text, its display name, its agent, its session key, or the order
 * it finished in. Nor does where it ran: a queue per coroutine would also hold
 * calls that never become records, because the public `Agent.prompt()` is
 * reachable by any registered component and journals nothing.
 *
 * So the journal boundary itself says which turn is which. Core calls this
 * owner's `begin()` at the one moment that is both canonical and live — in the
 * turn's own scope, as its private audit ledger is placed — and hands back the
 * very same value on the publication that ends it. `append()` is the single
 * durable handoff, and the live turn it began is removed inside that same
 * transition, so no announced snapshot holds a turn both ways or neither.
 *
 * A direct `Agent.prompt()` call begins nothing. It gets no reading, claims no
 * record, and cannot be claimed by one. A turn replay restored asks no
 * provider, so it begins nothing either: no association, and no live turn.
 *
 * ## A request without one owner is an invariant failure
 *
 * An interactive permission request belongs to the live turn on whose coroutine
 * the provider asked. Where there is not exactly one, this publishes nothing,
 * denies nothing, and fails the session — reporting to the session owner as
 * well as to the permission operation, because an ordinary `<Prompt>` turns a
 * provider failure into its own durable failed result and carries on, which
 * would leave the REPL running without the identity it needs to present and
 * answer requests correctly.
 */

import { action, createSignal, useScope } from "effection";
import type { Operation, Scope, Stream } from "effection";
import { Agent, denyPermission } from "@executablemd/core";
import type {
  AgentPromptEvent,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
} from "@executablemd/core";
import { useAgentPromptPublisher } from "@executablemd/core/host";
import type {
  AgentPromptHandle,
  AgentPromptPublication,
  AgentPromptPublisher,
  ExecutionInstallation,
} from "@executablemd/core/host";
import { DurableContext } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

/** The durable record one observed turn is waiting to be replaced by. */
const AGENT_PROMPT = "agent_prompt";

/** How far one live turn has got, as this process saw it. */
export type ReplLiveTurnState = "queued" | "active" | "terminal";

/** One option the provider offered for a pending request, detached from it. */
export interface ReplLiveChoice {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOption["kind"];
}

/**
 * One Agent turn this process is running, as the application reads it.
 *
 * Everything here arrived from the provider's own events. A member is absent
 * until the event carrying it has gone past, so an empty `sessionKey` means
 * "not started yet" rather than "no conversation" — a queued turn has no
 * conversation to select, and inferring one from the authored options would
 * name a session the provider never issued.
 */
export interface ReplLiveTurn {
  /** This process's own opaque handle. Never a location, model or Journal value. */
  readonly key: string;
  /** The text the Prompt asked. */
  readonly prompt: string;
  readonly state: ReplLiveTurnState;
  /** What the provider has streamed so far. */
  readonly text: string;
  readonly agent: string | undefined;
  readonly sessionKey: string | undefined;
  readonly agentSessionId: string | undefined;
  readonly status: "completed" | "failed" | "cancelled" | undefined;
  readonly stopReason: string | undefined;
  /** What the provider said went wrong, as one line. */
  readonly failure: string | undefined;
}

/** One permission request waiting on a person, detached from the request itself. */
export interface ReplLivePermission {
  /** This process's own opaque handle for the request. */
  readonly key: string;
  /** The live turn that owns it. */
  readonly turn: string;
  readonly toolCallId: string;
  readonly title: string | undefined;
  readonly kind: string | undefined;
  readonly choices: readonly ReplLiveChoice[];
}

/** Everything this process knows about live Agent work right now. */
export interface ReplAgentReading {
  /** Live turns in the order their Prompts were observed. */
  readonly turns: readonly ReplLiveTurn[];
  readonly requests: readonly ReplLivePermission[];
}

/**
 * Settling a pending request, separated from reading it.
 *
 * A surface that draws requests receives the reading; only the owner of this
 * settles one. Both take an opaque key, so an unknown, stale or already
 * answered key acts on nothing rather than on whatever is pending now.
 */
export interface ReplAgentAuthority {
  /** Answer with one offered option. */
  choose(request: string, option: string): boolean;
  /** Dismiss while the session is live, which denies. */
  dismiss(request: string): boolean;
}

/** The private live Agent owner one session installs into its execution. */
export interface ReplAgentKernel {
  readonly reading: ReplAgentReading;
  readonly changes: Stream<ReplAgentReading, never>;
  readonly authority: ReplAgentAuthority;
  /** What this owner installs inside the execution. */
  readonly installation: ExecutionInstallation;
  /**
   * The publisher that ties each canonical `<Prompt>` to its live turn.
   *
   * Installed by `installation`; exposed so a caller can see the one seam this
   * owner correlates through.
   */
  readonly publisher: AgentPromptPublisher;
  /**
   * Account for one appended event, without announcing.
   *
   * The caller owns the transition: it projects the newly acknowledged history,
   * calls this, and announces once — so no observable snapshot holds a turn
   * twice or neither time.
   */
  consume(event: DurableEvent): void;
  /** Announce the reading the caller's transition arrived at. */
  announce(): void;
  /**
   * The first failure that must terminate this session's owner.
   *
   * Resolves once. A later failure cannot replace it, because the owner is
   * already withdrawing the authority the later one would have described.
   */
  readonly failed: Operation<Error>;
}

/** An unowned or ambiguously owned interactive permission request. */
export class ReplPermissionOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplPermissionOwnerError";
  }
}

/** An append this process cannot match to the work it completed. */
export class ReplAgentCorrelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplAgentCorrelationError";
  }
}

/** Mutable bookkeeping for one observed turn. */
interface LiveTurn {
  readonly key: string;
  readonly coroutine: string;
  readonly prompt: string;
  state: ReplLiveTurnState;
  text: string;
  agent: string | undefined;
  sessionKey: string | undefined;
  agentSessionId: string | undefined;
  status: "completed" | "failed" | "cancelled" | undefined;
  stopReason: string | undefined;
  failure: string | undefined;
}

interface LiveRequest {
  readonly key: string;
  readonly turn: string;
  readonly toolCallId: string;
  readonly title: string | undefined;
  readonly kind: string | undefined;
  readonly choices: readonly ReplLiveChoice[];
  /** The one wait this answers, and the request only it may see. */
  settle(outcome: PermissionOutcome): void;
  readonly request: PermissionRequest;
}

function frozenTurn(turn: LiveTurn): ReplLiveTurn {
  return Object.freeze({
    key: turn.key,
    prompt: turn.prompt,
    state: turn.state,
    text: turn.text,
    agent: turn.agent,
    sessionKey: turn.sessionKey,
    agentSessionId: turn.agentSessionId,
    status: turn.status,
    stopReason: turn.stopReason,
    failure: turn.failure,
  });
}

function frozenRequest(request: LiveRequest): ReplLivePermission {
  return Object.freeze({
    key: request.key,
    turn: request.turn,
    toolCallId: request.toolCallId,
    title: request.title,
    kind: request.kind,
    choices: request.choices,
  });
}

/** The choices a provider offered, copied out of the request it owns. */
function offeredChoices(request: PermissionRequest): readonly ReplLiveChoice[] {
  return Object.freeze(
    request.options.map((option) =>
      Object.freeze({ optionId: option.optionId, name: option.name, kind: option.kind }),
    ),
  );
}

/** The approval a mode would select, or none when the provider offered neither. */
function approval(request: PermissionRequest): PermissionOutcome | undefined {
  const allowed =
    request.options.find((option) => option.kind === "allow_once") ??
    request.options.find((option) => option.kind === "allow_always");
  return allowed === undefined ? undefined : { outcome: "selected", optionId: allowed.optionId };
}

/** Whether this tool call is one `approve-reads` decides without asking. */
function isRead(request: PermissionRequest): boolean {
  const kind = request.toolCall.kind;
  return kind === "read" || kind === "search";
}

/** The coroutine this operation is running on, or `""` outside a journal. */
function* currentCoroutine(): Operation<string> {
  const scope = yield* useScope();
  return scope.get(DurableContext)?.coroutineId ?? "";
}

/**
 * Create the private live Agent owner for one session.
 *
 * The owner is created here and installed into the execution through
 * `installation`, so everything it holds belongs to the scope that created it
 * and dies with that scope — including the middleware, which an execution
 * elsewhere would otherwise inherit.
 */
export function useReplAgent(mode: PermissionMode): ReplAgentKernel {
  const changes = createSignal<ReplAgentReading, never>();
  const turns: LiveTurn[] = [];
  const requests: LiveRequest[] = [];
  /** The live turn core began in a scope, until that scope's prompt claims it. */
  const begun = new Map<Scope, LiveTurn>();
  /**
   * The live turn each handle this owner minted stands for.
   *
   * The handle is an object of this owner's own making, so a value from
   * anywhere else simply is not a key here — which is how a handle is read
   * back without asserting anything about what it is.
   */
  const minted = new WeakMap<object, LiveTurn>();
  /**
   * The canonical publication appending right now on each coroutine.
   *
   * The handle is what identifies the turn; this only says which of several
   * concurrent publications an append belongs to. At most one canonical
   * publication is ever in flight per coroutine, because expansion inside one
   * coroutine is strictly sequential — so this is an index, never a queue, and
   * it holds nothing between transitions.
   */
  const publishing = new Map<string, LiveTurn>();
  let reading: ReplAgentReading = Object.freeze({
    turns: Object.freeze([]),
    requests: Object.freeze([]),
  });
  let keys = 0;
  let failure: Error | undefined;
  const failures: Array<(error: Error) => void> = [];

  function allocate(prefix: string): string {
    keys += 1;
    return `${prefix}-${keys}`;
  }

  function project(): void {
    reading = Object.freeze({
      turns: Object.freeze(turns.map(frozenTurn)),
      requests: Object.freeze(requests.map(frozenRequest)),
    });
  }

  function announce(): void {
    project();
    changes.send(reading);
  }

  /**
   * Record the first failure that must end this session, and report it.
   *
   * Reported to whoever is waiting rather than thrown here: the caller also has
   * to raise it into the operation that caused it, and the two are different
   * deliveries of one failure.
   */
  function fail(error: Error): Error {
    if (failure === undefined) {
      failure = error;
      for (const waiting of failures) {
        waiting(error);
      }
      failures.length = 0;
    }
    return failure;
  }

  /** Take one live turn down, leaving the announcement to the caller. */
  function retire(turn: LiveTurn): void {
    const at = turns.indexOf(turn);
    if (at >= 0) {
      turns.splice(at, 1);
    }
  }

  function queued(coroutine: string, prompt: string): LiveTurn {
    const turn: LiveTurn = {
      key: allocate("turn"),
      coroutine,
      prompt,
      state: "queued",
      text: "",
      agent: undefined,
      sessionKey: undefined,
      agentSessionId: undefined,
      status: undefined,
      stopReason: undefined,
      failure: undefined,
    };
    turns.push(turn);
    announce();
    return turn;
  }

  /** Copy one provider event's facts into the reading, changing nothing else. */
  function observed(turn: LiveTurn, event: AgentPromptEvent): void {
    if (event.type === "started") {
      turn.state = "active";
      turn.agent = event.agent;
      turn.sessionKey = event.session.sessionKey;
      turn.agentSessionId = event.session.agentSessionId;
    } else if (event.type === "text_delta") {
      turn.state = "active";
      turn.text += event.text;
    } else {
      turn.state = "terminal";
      turn.status = event.status;
      turn.stopReason = event.stopReason;
      turn.failure = event.error?.message;
    }
    announce();
  }

  /**
   * Wrap the provider's cold stream so subscribing still starts exactly one
   * turn, owned by `<Prompt>`.
   *
   * Nothing is collected, pre-read or replaced: each event travels back the
   * moment it arrives, as the same object the provider produced, and the final
   * value is the provider's own.
   */
  function watch(
    turn: LiveTurn,
    stream: Stream<AgentPromptEvent, string>,
  ): Stream<AgentPromptEvent, string> {
    return {
      *[Symbol.iterator]() {
        const subscription = yield* stream;
        return {
          *next() {
            const next = yield* subscription.next();
            if (!next.done) {
              observed(turn, next.value);
            }
            return next;
          },
        };
      },
    };
  }

  /** The live turn a permission request on this coroutine belongs to. */
  function owner(coroutine: string): LiveTurn {
    const candidates = turns.filter(
      (turn) => turn.coroutine === coroutine && turn.state !== "terminal",
    );
    const only = candidates[0];
    if (only === undefined || candidates.length > 1) {
      throw fail(
        new ReplPermissionOwnerError(
          candidates.length > 1
            ? "an interactive permission request arrived where more than one live Prompt turn " +
                "could own it, so the session cannot say which conversation is asking."
            : "an interactive permission request arrived with no live Prompt turn to own it, so " +
                "the session cannot present or answer it.",
        ),
      );
    }
    return only;
  }

  function remove(request: LiveRequest): void {
    const at = requests.indexOf(request);
    if (at >= 0) {
      requests.splice(at, 1);
    }
  }

  function* interactive(request: PermissionRequest): Operation<PermissionOutcome> {
    // Decided before anything is published: an unowned request publishes no
    // reading and no key, and never becomes a denial.
    const held = owner(yield* currentCoroutine());
    return yield* action<PermissionOutcome>(function (resolve) {
      let settled = false;
      const live: LiveRequest = {
        key: allocate("request"),
        turn: held.key,
        toolCallId: request.toolCall.toolCallId,
        title: request.toolCall.title,
        kind: request.toolCall.kind,
        choices: offeredChoices(request),
        request,
        settle(outcome: PermissionOutcome): void {
          if (settled) {
            return;
          }
          settled = true;
          remove(live);
          announce();
          resolve(outcome);
        },
      };
      // Whatever ends this — an answer, a dismissal, teardown, a failure
      // upstream — the reading disappears exactly when the wait does. Returned
      // as `action`'s own cleanup, which is registered before this body's
      // caller can suspend, and the wait is never resolved synchronously.
      const dispose = (): void => {
        if (!settled) {
          settled = true;
          remove(live);
          announce();
        }
      };
      requests.push(live);
      announce();
      return dispose;
    });
  }

  /**
   * The selected mode, applied exactly, with every other kind asked.
   *
   * A mode that cannot approve denies through Core's own `denyPermission`
   * rather than a rule spelled again here, so an automatic denial is the same
   * decision the base handler would have reached.
   */
  function* decide(request: PermissionRequest): Operation<PermissionOutcome> {
    if (mode === "approve-all") {
      return approval(request) ?? denyPermission(request);
    }
    if (mode === "deny-all") {
      return denyPermission(request);
    }
    if (isRead(request)) {
      return approval(request) ?? denyPermission(request);
    }
    return yield* interactive(request);
  }

  const authority: ReplAgentAuthority = {
    choose(request: string, option: string): boolean {
      const live = requests.find((candidate) => candidate.key === request);
      if (live === undefined) {
        return false;
      }
      // Only what the provider offered: a stray identifier settles nothing
      // rather than selecting an option this turn was never given.
      if (!live.choices.some((choice) => choice.optionId === option)) {
        return false;
      }
      live.settle({ outcome: "selected", optionId: option });
      return true;
    },
    dismiss(request: string): boolean {
      const live = requests.find((candidate) => candidate.key === request);
      if (live === undefined) {
        return false;
      }
      // A dismissal while the session continues is a denial the provider turn
      // resumes with, decided by the one authoritative rule.
      live.settle(denyPermission(live.request));
      return true;
    },
  };

  const publisher: AgentPromptPublisher = {
    *begin(input: string): Operation<AgentPromptHandle> {
      // Created before the provider is asked for anything at all, and handed
      // back on this turn's own publication — the only thing that will say
      // which live turn that record ended.
      const turn = queued(yield* currentCoroutine(), input);
      begun.set(yield* useScope(), turn);
      // An opaque token rather than the turn itself: core carries it back
      // untouched, and only this map can say what it stood for.
      const handle: object = {};
      minted.set(handle, turn);
      return handle;
    },
    *publish(publication: AgentPromptPublication): Operation<void> {
      const handle = publication.begun;
      // A handle this owner did not mint is not a key in this map: another
      // host's publisher, or a turn from an execution this session never ran.
      // Read back by lookup, never by asserting what the value is.
      const turn = typeof handle === "object" && handle !== null ? minted.get(handle) : undefined;
      const where = turn?.coroutine;
      if (turn !== undefined && where !== undefined) {
        publishing.set(where, turn);
      }
      try {
        // The single durable handoff. `consume()` runs inside this append, in
        // the caller's one transition, and removes exactly this turn.
        yield* publication.append();
      } catch (error) {
        // Nothing was retained, so nothing may still be shown as though it is
        // about to be. The turn this publication began is taken down and the
        // removal announced before the failure travels on — otherwise a
        // terminal overlay outlives the record it was waiting for.
        if (turn !== undefined) {
          retire(turn);
          announce();
        }
        throw error;
      } finally {
        if (where !== undefined) {
          publishing.delete(where);
        }
      }
    },
  };

  const installation: ExecutionInstallation = {
    *install(): Operation<void> {
      // At the ordinary position, not `min`. A provider installs its own
      // handlers innermost and answers without delegating, so an observer
      // installed there would never see the call it exists to wrap — and a
      // policy installed there would be decided for, by whatever the provider
      // brought with it. Outermost is where this session's own authority goes:
      // it wraps the provider's stream, and it decides permission before
      // anything inherited can.
      yield* useAgentPromptPublisher(publisher);
      yield* Agent.around({
        *prompt([text, options], next) {
          // Only the turn core began in this exact scope is journal-owned work.
          // A registered component calling the public `Agent.prompt()` arrives
          // here having begun nothing: it is delegated untouched, shown in no
          // reading, and left unable to claim any record.
          const scope = yield* useScope();
          const turn = begun.get(scope);
          begun.delete(scope);
          const stream = yield* next(text, options);
          return turn === undefined ? stream : watch(turn, stream);
        },
        *requestPermission([request]) {
          return yield* decide(request);
        },
      });
    },
  };

  return {
    get reading() {
      return reading;
    },
    changes,
    authority,
    installation,
    publisher,
    consume(event: DurableEvent): void {
      if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
        return;
      }
      const turn = publishing.get(event.coroutineId);
      if (turn === undefined) {
        // An `agent_prompt` appended where this process observed no turn. The
        // session has already been admitted, so there is nothing left to refuse
        // atomically: the owner is terminated instead of guessing which reading
        // this record replaced.
        throw fail(
          new ReplAgentCorrelationError(
            "an agent turn was recorded that this session never observed, so its live view " +
              "cannot be reconciled with the journal.",
          ),
        );
      }
      retire(turn);
      project();
    },
    announce,
    get failed(): Operation<Error> {
      return {
        *[Symbol.iterator]() {
          if (failure !== undefined) {
            return failure;
          }
          return yield* action<Error>(function (resolve) {
            failures.push(resolve);
            return () => {
              const at = failures.indexOf(resolve);
              if (at >= 0) {
                failures.splice(at, 1);
              }
            };
          });
        },
      };
    },
  };
}

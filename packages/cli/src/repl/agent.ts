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
 * ## Correlation is by coroutine, not by resemblance
 *
 * Two `<Spawn>` children may run identical prompts against identical responses
 * and settle in either order, so nothing about a turn's *content* identifies
 * it: not its text, its display name, its agent, its session key, or the order
 * it finished in. What does identify it is where it ran. Each spawned child is
 * its own durable coroutine, expansion inside one coroutine is strictly
 * sequential, and an `agent_prompt` record appends on the coroutine that made
 * it — so the Nth prompt this execution observed on coroutine X is the Nth
 * `agent_prompt` appended on coroutine X. That is a queue per coroutine, and it
 * is exact.
 *
 * A turn replay restored never reaches this middleware and never appends, so it
 * produces no reading and consumes no queue entry.
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
import type { Operation, Stream } from "effection";
import { Agent, denyPermission } from "@executablemd/core";
import type {
  AgentPromptEvent,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
} from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";
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
  /** Turns observed on one coroutine and not yet replaced by their record. */
  const awaiting = new Map<string, string[]>();
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
    const pending = awaiting.get(coroutine);
    if (pending === undefined) {
      awaiting.set(coroutine, [turn.key]);
    } else {
      pending.push(turn.key);
    }
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

  const installation: ExecutionInstallation = {
    *install(): Operation<void> {
      // At the ordinary position, not `min`. A provider installs its own
      // handlers innermost and answers without delegating, so an observer
      // installed there would never see the call it exists to wrap — and a
      // policy installed there would be decided for, by whatever the provider
      // brought with it. Outermost is where this session's own authority goes:
      // it wraps the provider's stream, and it decides permission before
      // anything inherited can.
      yield* Agent.around({
        *prompt([text, options], next) {
          const turn = queued(yield* currentCoroutine(), text);
          // Published first, delegated second: the reading exists before the
          // provider is asked for anything at all.
          const stream = yield* next(text, options);
          return watch(turn, stream);
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
    consume(event: DurableEvent): void {
      if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
        return;
      }
      const pending = awaiting.get(event.coroutineId);
      const key = pending?.shift();
      if (key === undefined) {
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
      const at = turns.findIndex((turn) => turn.key === key);
      if (at >= 0) {
        turns.splice(at, 1);
      }
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

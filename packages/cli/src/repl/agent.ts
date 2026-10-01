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

import { action, createSignal, ensure, resource, useScope } from "effection";
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
  /**
   * The admission-order key of the entry whose execution began this turn.
   *
   * Taken when the turn began, from the installation that entry's execution was
   * started with, and carried unchanged from there. A reader asking which entry
   * a turn belongs to is never answered with the entry that is running now: a
   * turn that published under one entry stays that entry's while the next one
   * runs.
   */
  readonly entry: string;
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

/**
 * Where one observed Prompt sits, and what it became.
 *
 * A slot outlives the live turn it began as. Publication changes where a turn's
 * facts come from — the record, rather than this process's observation — and it
 * is the same turn a person was already looking at, so the slot keeps one
 * position and one identity across that change. Without it a reader has only
 * two disjoint lists and has to guess which durable row replaced which live one.
 *
 * `order` is observation order, which is the order Prompts were scheduled in;
 * `durable` is the name the record was journaled under, once the append that
 * replaced this turn has been accounted for. `entry` is the entry that began it,
 * which publication does not change either — the record that replaced this turn
 * belongs to the same entry the turn did. Everything here is process-local: no
 * slot, key or order reaches a location, the model or the Journal.
 */
export interface ReplAgentSlot {
  /** The live key this Prompt was observed under, and stays mounted as. */
  readonly key: string;
  /** The admission-order key of the entry whose execution began this Prompt. */
  readonly entry: string;
  /** Where this Prompt sits among the ones this process observed. */
  readonly order: number;
  /** The durable name its record was journaled under, or none while it is live. */
  readonly durable: string | undefined;
  /**
   * The facts this turn had when it published, or none while it is still live.
   *
   * Kept so the row can never blank: the append is accounted for here and the
   * record is projected by whoever owns the transition, and a reader that had
   * only the two lists would show nothing for this turn in between.
   */
  readonly last: ReplLiveTurn | undefined;
}

/** Everything this process knows about live Agent work right now. */
export interface ReplAgentReading {
  /** Live turns in the order their Prompts were observed. */
  readonly turns: readonly ReplLiveTurn[];
  readonly requests: readonly ReplLivePermission[];
  /**
   * Every Prompt this process observed, live or since published.
   *
   * In observation order. A reader presents these rather than concatenating the
   * live turns with the retained ones, because a turn that has published is
   * still in the same place it was.
   */
  readonly slots: readonly ReplAgentSlot[];
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
  /**
   * The Agent attachment one entry's execution installs.
   *
   * An operation rather than a value, because what it hands back is held by a
   * resource: acquiring it inside the entry task gives that entry's live turns,
   * pending requests, provisional slots and handle lookups a lifetime of their
   * own, and releasing that scope discards exactly what the execution did not
   * durably transfer. The entry key is an argument, so a turn cannot begin under
   * an entry nobody named.
   *
   * Acquire it before `executeInstalled()` and install the result only into that
   * entry's execution.
   */
  owning(entry: string): Operation<ExecutionInstallation>;
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
  readonly entry: string;
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

/** Mutable bookkeeping for one observed Prompt's place in the reading. */
interface Slot {
  readonly key: string;
  readonly entry: string;
  readonly order: number;
  durable: string | undefined;
  last: ReplLiveTurn | undefined;
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
    entry: turn.entry,
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

function frozenSlot(slot: Slot): ReplAgentSlot {
  return Object.freeze({
    key: slot.key,
    entry: slot.entry,
    order: slot.order,
    durable: slot.durable,
    last: slot.last,
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
 * One entry's Agent attachment: what that entry's execution owns, and no more.
 *
 * Every value here is live-only and belongs to one `executeInstalled()` call. It
 * is held by a resource acquired inside that entry's task, so the question "what
 * does this entry still hold?" is answered by an object rather than by scanning a
 * session-wide list for a key — and the answer stops existing when the execution
 * does.
 *
 * `minted` is the structural half of the same point: handles are looked up in
 * *this* attachment's map, so a handle from an entry that has ended is not a key
 * anywhere and cannot correlate with anything. Nothing has to remember to forget
 * it.
 */
interface Attachment {
  readonly entry: string;
  /** The turns this entry is running, none of which a record holds yet. */
  readonly turns: LiveTurn[];
  readonly requests: LiveRequest[];
  /** The places this entry's Prompts took, which no record has taken over. */
  readonly slots: Slot[];
  readonly begun: Map<Scope, LiveTurn>;
  readonly minted: WeakMap<object, LiveTurn>;
  readonly publishing: Map<string, LiveTurn>;
}

/** Take one live turn down inside the attachment holding it. */
function retire(attachment: Attachment, turn: LiveTurn): void {
  const at = attachment.turns.indexOf(turn);
  if (at >= 0) {
    attachment.turns.splice(at, 1);
  }
}

/** Take one pending request down inside the attachment holding it. */
function remove(attachment: Attachment, request: LiveRequest): void {
  const at = attachment.requests.indexOf(request);
  if (at >= 0) {
    attachment.requests.splice(at, 1);
  }
}

/**
 * The private live Agent owner for one session, for as long as that session.
 *
 * A resource, because everything it holds is mutable and session-scoped: the
 * announcement channel, the slots records have taken over, the keys and places
 * every entry draws from, and who is waiting on the first failure.
 *
 * ## The session owns what the Journal owns; an entry owns the rest
 *
 * A session lasts for several entries and each entry's live state lasts for one
 * execution, so the two are held apart. This owner keeps the reading and its
 * channel, session-wide key and place allocation, the permission authority, the
 * first fatal failure — and the slots a successful publication *transferred* to
 * it, because a published turn is a fact about the Journal and has to outlive the
 * execution that produced it.
 *
 * Everything else belongs to one entry's `Attachment`, acquired inside that
 * entry's task through `owning()`. Releasing that resource discards exactly what
 * the execution did not transfer, which is why nothing here scans for an entry
 * key: the attachment instance *is* the authority for what it owned.
 *
 * Retiring answers nothing and releases nothing. A permission wait still held at
 * teardown is abandoned, not denied — the scope that raised it is going away too,
 * and a decision invented on the way out would be a decision nobody made. The
 * same goes for whoever was waiting on `failed`: there is no failure to report,
 * so no one is woken. No teardown path appends a record, writes an audit or
 * closes a coroutine.
 */
export function useReplAgent(mode: PermissionMode): Operation<ReplAgentKernel> {
  return resource(function* (provide) {
    const changes = createSignal<ReplAgentReading, never>();
    /**
     * The slots a durable record has taken over, in observation order.
     *
     * Session-owned the moment the append is accounted for. A reader looking at a
     * published turn is looking at the Journal, and the entry that wrote it ending
     * is not a reason for that row to disappear.
     */
    const transferred: Slot[] = [];
    /** The one entry attachment that is live, or none between entries. */
    let attached: Attachment | undefined;
    let reading: ReplAgentReading = Object.freeze({
      turns: Object.freeze([]),
      requests: Object.freeze([]),
      slots: Object.freeze([]),
    });
    /**
     * Session-wide, so one key and one place mean one thing across every entry.
     *
     * A place is observation order over the whole session: an entry's Prompts take
     * places after the entry before it, which is what keeps a published slot where
     * it was once the next entry starts taking places of its own.
     */
    let keys = 0;
    let places = 0;
    let failure: Error | undefined;
    const failures: Array<(error: Error) => void> = [];

    function allocate(prefix: string): string {
      keys += 1;
      return `${prefix}-${keys}`;
    }

    function project(): void {
      const live = attached;
      // One list out of two owners, ordered by the place each slot took rather
      // than by which owner holds it now: publication moves a slot between them
      // and must not move it on the screen.
      // Sorted over a fresh copy, so the two owners' own lists are untouched.
      // `toSorted()` is unavailable here: the Node typecheck gate targets ES2022.
      const placed = [...transferred, ...(live?.slots ?? [])].sort(
        (left, right) => left.order - right.order,
      );
      reading = Object.freeze({
        turns: Object.freeze((live?.turns ?? []).map(frozenTurn)),
        requests: Object.freeze((live?.requests ?? []).map(frozenRequest)),
        slots: Object.freeze(placed.map(frozenSlot)),
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

    /**
     * Discard what one attachment still holds, because its execution is over.
     *
     * Whatever is still in it was never transferred — publication is the one thing
     * that moves a slot out — so this needs no notion of "published" to avoid
     * taking one down. A request is dropped rather than settled, and nothing is
     * appended, denied or cancelled on the way out.
     *
     * One announcement, after every removal, so no reader ever observes half of a
     * teardown.
     */
    function discard(attachment: Attachment): void {
      const held =
        attachment.turns.length > 0 ||
        attachment.requests.length > 0 ||
        attachment.slots.length > 0;
      attachment.turns.length = 0;
      attachment.requests.length = 0;
      attachment.slots.length = 0;
      attachment.begun.clear();
      attachment.publishing.clear();
      if (attached === attachment) {
        attached = undefined;
      }
      if (held) {
        announce();
      } else {
        project();
      }
    }

    function queued(attachment: Attachment, coroutine: string, prompt: string): LiveTurn {
      const turn: LiveTurn = {
        key: allocate("turn"),
        entry: attachment.entry,
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
      places += 1;
      attachment.turns.push(turn);
      // Its place, taken when the Prompt was scheduled rather than when it
      // finished: a turn that publishes first did not thereby happen first.
      attachment.slots.push({
        key: turn.key,
        entry: attachment.entry,
        order: places,
        durable: undefined,
        last: undefined,
      });
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

    /**
     * The live turn a permission request on this coroutine belongs to.
     *
     * Looked for among this entry's own turns, which is why a coroutine id reused
     * by the next entry cannot make two candidates of one request: the entry
     * before it holds none of them any more.
     */
    function owner(attachment: Attachment, coroutine: string): LiveTurn {
      const candidates = attachment.turns.filter(
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

    function* interactive(
      attachment: Attachment,
      request: PermissionRequest,
    ): Operation<PermissionOutcome> {
      // Decided before anything is published: an unowned request publishes no
      // reading and no key, and never becomes a denial.
      const held = owner(attachment, yield* currentCoroutine());
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
            remove(attachment, live);
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
            remove(attachment, live);
            announce();
          }
        };
        attachment.requests.push(live);
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
    function* decide(
      attachment: Attachment,
      request: PermissionRequest,
    ): Operation<PermissionOutcome> {
      if (mode === "approve-all") {
        return approval(request) ?? denyPermission(request);
      }
      if (mode === "deny-all") {
        return denyPermission(request);
      }
      if (isRead(request)) {
        return approval(request) ?? denyPermission(request);
      }
      return yield* interactive(attachment, request);
    }

    /**
     * Settling a request, routed to the attachment that is live.
     *
     * A key minted by an entry whose execution has ended is not a key in any live
     * attachment, so it settles nothing rather than reaching a wait nobody holds.
     */
    const authority: ReplAgentAuthority = {
      choose(request: string, option: string): boolean {
        const live = attached?.requests.find((candidate) => candidate.key === request);
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
        const live = attached?.requests.find((candidate) => candidate.key === request);
        if (live === undefined) {
          return false;
        }
        // A dismissal while the session continues is a denial the provider turn
        // resumes with, decided by the one authoritative rule.
        live.settle(denyPermission(live.request));
        return true;
      },
    };

    function publisherFor(attachment: Attachment): AgentPromptPublisher {
      return {
        *begin(input: string): Operation<AgentPromptHandle> {
          // Created before the provider is asked for anything at all, and handed
          // back on this turn's own publication — the only thing that will say
          // which live turn that record ended.
          const turn = queued(attachment, yield* currentCoroutine(), input);
          attachment.begun.set(yield* useScope(), turn);
          // An opaque token rather than the turn itself: core carries it back
          // untouched, and only this attachment's map can say what it stood for.
          const handle: object = {};
          attachment.minted.set(handle, turn);
          return handle;
        },
        *publish(publication: AgentPromptPublication): Operation<void> {
          const handle = publication.begun;
          // A handle this attachment did not mint is not a key in its map: another
          // host's publisher, or a turn from an execution this one never ran.
          // Read back by lookup, never by asserting what the value is.
          const turn =
            typeof handle === "object" && handle !== null
              ? attachment.minted.get(handle)
              : undefined;
          const where = turn?.coroutine;
          if (turn !== undefined && where !== undefined) {
            attachment.publishing.set(where, turn);
          }
          try {
            // The single durable handoff. `consume()` runs inside this append, in
            // the caller's one transition, and transfers exactly this turn's slot.
            yield* publication.append();
          } catch (error) {
            // Nothing was retained, so nothing may still be shown as though it is
            // about to be. The turn this publication began is taken down and the
            // removal announced before the failure travels on — otherwise a
            // terminal overlay outlives the record it was waiting for. Its slot
            // stays untransferred, so this entry's teardown discards it.
            if (turn !== undefined) {
              retire(attachment, turn);
              announce();
            }
            throw error;
          } finally {
            if (where !== undefined) {
              attachment.publishing.delete(where);
            }
          }
        },
      };
    }

    function installationFor(attachment: Attachment): ExecutionInstallation {
      const publisher = publisherFor(attachment);
      return {
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
              const turn = attachment.begun.get(scope);
              attachment.begun.delete(scope);
              const stream = yield* next(text, options);
              return turn === undefined ? stream : watch(turn, stream);
            },
            *requestPermission([request]) {
              return yield* decide(attachment, request);
            },
          });
        },
      };
    }

    function owning(entry: string): Operation<ExecutionInstallation> {
      return resource(function* (attach) {
        const attachment: Attachment = {
          entry,
          turns: [],
          requests: [],
          slots: [],
          begun: new Map(),
          minted: new WeakMap(),
          publishing: new Map(),
        };
        // Registered before this attachment becomes the live one, so nothing can
        // land between taking the slot and arranging to give it back.
        yield* ensure(() => {
          discard(attachment);
        });
        attached = attachment;
        yield* attach(installationFor(attachment));
      });
    }

    const kernel: ReplAgentKernel = {
      get reading() {
        return reading;
      },
      changes,
      authority,
      owning,
      consume(event: DurableEvent): void {
        if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
          return;
        }
        const live = attached;
        const turn = live?.publishing.get(event.coroutineId);
        if (live === undefined || turn === undefined) {
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
        // The one transfer, inside the one append. The live facts are gone and the
        // record holds them now — but this is the same turn, in the same place, so
        // its slot moves from the entry that produced it to this session with its
        // mounted key, its entry key and its place unchanged. From here the entry
        // ending cannot take it away.
        const at = live.slots.findIndex((candidate) => candidate.key === turn.key);
        if (at >= 0) {
          const slot = live.slots[at];
          live.slots.splice(at, 1);
          slot.durable = event.description.name;
          slot.last = frozenTurn(turn);
          transferred.push(slot);
        }
        retire(live, turn);
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

    try {
      yield* provide(kernel);
    } finally {
      // What is left here is this session's own. Every entry attachment discarded
      // what it held when its execution ended, and a waiting `failed` resolver is
      // reporting a failure that never happened, so it is dropped rather than
      // woken.
      failures.length = 0;
      transferred.length = 0;
      attached = undefined;
      // Projected, not announced. A reader still holding this owner sees a
      // retired one; nothing is pushed into consumers that are themselves going
      // away.
      project();
    }
  });
}

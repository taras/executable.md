/**
 * Issue #774 POC — the immutable REPL state and its reducer.
 *
 * A disposable proof, not a production surface. Nothing here is exported from
 * the package: it lives under `poc/repl/` and is reached only by the
 * deterministic evidence in `packages/terminal-tmux/tests/repl-poc.test.ts` and
 * by the gated live supervisor beside it.
 *
 * One Flux-style store holds this shape. Actions are the only way it changes,
 * and the reducer here is the only place a transition is written. Observers,
 * convergence monitors and the delivery worker dispatch actions; none of them
 * mutates a role directly. Every reducer returns a fresh value rather than
 * editing its input, so a persisted action history replays to exactly the state
 * the live run held.
 *
 * There is no generic `delivered` message state. Terminal input does not prove
 * delivery, so a message that was pasted sits at `attempt-started` until the
 * provider's own session file records the exact user event — or becomes
 * `uncertain` when that evidence never arrives.
 */

import type { ReplAction } from "./actions.ts";

export const STATE_SCHEMA = "terminal-repl-poc-state.v1" as const;

/** Which coding agent a role drives. The POC supports exactly these two. */
export type Provider = "claude" | "codex";

/**
 * What terminal convergence has established about a pane, independent of any
 * provider evidence.
 *
 * `ready` is only an authorization to attempt an input; it never means a
 * message was accepted.
 */
export type Readiness = "unknown" | "converging" | "ready" | "busy" | "unavailable";

/**
 * The lifecycle of one REPL message.
 *
 * `attempt-started` is the durable record written *before* any terminal byte is
 * sent, so a restart that finds it treats the outcome as `uncertain` rather than
 * pasting again.
 */
export type MessageState =
  | "queued"
  | "converging"
  | "attempt-started"
  | "accepted"
  | "completed"
  | "refused"
  | "uncertain";

/** The exact provider-native identity the isolated launch journal retained. */
export interface NativeIdentity {
  readonly provider: Provider;
  /** The provider's own session identifier, matched exactly and never inferred. */
  readonly id: string;
}

/** One normalized provider event, keyed by file identity and byte range. */
export interface NormalizedEvent {
  readonly kind: "user-accepted" | "assistant-output" | "turn-completed";
  /** Derived from the source file identity and the record's byte range. */
  readonly key: string;
  /** The native identity the record belongs to, carried for cross-checking. */
  readonly identity: string;
  /** The relevant text, or the empty string for a completion boundary. */
  readonly text: string;
  /** The provider's own turn identity, when it groups output by one. */
  readonly turn?: string;
}

/** One REPL message and everything the store retains about it. */
export interface ReplMessage {
  readonly id: string;
  /** Queue order within its role, so the head is unambiguous. */
  readonly seq: number;
  /** The literal bytes to deliver. Never rendered into the report. */
  readonly text: string;
  /** A harmless unique marker the exact user event must carry back. */
  readonly marker: string;
  readonly state: MessageState;
  /** How many times an attempt has been started for this message. */
  readonly attempts: number;
}

/** One role's whole immutable slice of the store. */
export interface RoleState {
  readonly key: string;
  /** The authored role presentation value, e.g. "Implementor". */
  readonly role: string;
  /** The current issue presentation value. */
  readonly issue: string;
  readonly identity: NativeIdentity;
  /** Bumped when a pane is replaced; an old generation authorizes nothing. */
  readonly paneGeneration: number;
  /** The located source's opaque identity, or "" before the observer locates one. */
  readonly observerSource: string;
  /** The durable observer cursor: a byte offset that only ever advances. */
  readonly cursor: number;
  readonly readiness: Readiness;
  /** At most one message is in flight per pane; its id, or undefined. */
  readonly inFlight: string | undefined;
  /** Queued, admitted and settled messages in order. */
  readonly messages: readonly ReplMessage[];
  /** The normalized provider events observed for this role, in order. */
  readonly events: readonly NormalizedEvent[];
}

/** The whole retained state of one REPL session. */
export interface ReplState {
  readonly schema: typeof STATE_SCHEMA;
  /** The REPL's own retained XMD session identity. */
  readonly replSession: string;
  readonly roles: Readonly<Record<string, RoleState>>;
  /** The sequence number the next dispatched action will carry. */
  readonly nextAction: number;
}

/** The empty state a fresh store begins from. */
export function emptyState(): ReplState {
  return { schema: STATE_SCHEMA, replSession: "", roles: {}, nextAction: 0 };
}

/** Replace one role, leaving the rest of the map untouched. */
function withRole(state: ReplState, key: string, role: RoleState): ReplState {
  return { ...state, roles: { ...state.roles, [key]: role } };
}

/** Map one message by id, leaving the others as they are. */
function mapMessage(
  role: RoleState,
  id: string,
  change: (message: ReplMessage) => ReplMessage,
): RoleState {
  const messages = role.messages.map((message) => (message.id === id ? change(message) : message));
  return { ...role, messages };
}

/** The head of the queue: the earliest message still `queued`, or undefined. */
export function queueHead(role: RoleState): ReplMessage | undefined {
  return role.messages.find((message) => message.state === "queued");
}

/**
 * Fold one action into the state.
 *
 * The single place a transition is written. Every branch returns a fresh value;
 * an action naming a role the state does not hold is ignored rather than
 * throwing, because a replayed history is trusted to be well formed and a live
 * dispatch validates the role before it is sent.
 */
export function reduce(state: ReplState, action: ReplAction): ReplState {
  switch (action.type) {
    case "ReplOpened":
      return { ...state, replSession: action.replSession };
    case "RoleBound": {
      const role: RoleState = {
        key: action.key,
        role: action.role,
        issue: action.issue,
        identity: action.identity,
        paneGeneration: action.paneGeneration,
        observerSource: "",
        cursor: 0,
        readiness: "unknown",
        inFlight: undefined,
        messages: [],
        events: [],
      };
      return withRole(state, action.key, role);
    }
    case "ReplClosed":
      return state;
    default:
      return reduceRole(state, action);
  }
}

/** Every action that names an existing role folds through here. */
function reduceRole(state: ReplState, action: RoleAction): ReplState {
  const role = state.roles[action.key];
  if (role === undefined) {
    return state;
  }
  return withRole(state, action.key, reduceOne(role, action));
}

/** Actions that carry a role key, excluding the one that creates the role. */
type RoleAction = Exclude<Extract<ReplAction, { key: string }>, { type: "RoleBound" }>;

function reduceOne(role: RoleState, action: RoleAction): RoleState {
  switch (action.type) {
    case "MessageQueued": {
      const message: ReplMessage = {
        id: action.id,
        seq: role.messages.length,
        text: action.text,
        marker: action.marker,
        state: "queued",
        attempts: 0,
      };
      return { ...role, messages: [...role.messages, message] };
    }
    case "TerminalObserved":
      return { ...role, readiness: action.readiness };
    case "ProviderBusy":
      return { ...role, readiness: "busy" };
    case "ProviderIdle":
      return role.readiness === "busy" ? { ...role, readiness: "ready" } : role;
    case "ConvergenceStarted":
      return mapMessage({ ...role, readiness: "converging" }, action.id, (message) => ({
        ...message,
        state: "converging",
      }));
    case "ConvergenceInvalidated":
      return mapMessage(role, action.id, (message) =>
        message.state === "converging" ? { ...message, state: "queued" } : message,
      );
    case "AttemptStarted":
      return mapMessage({ ...role, inFlight: action.id }, action.id, (message) => ({
        ...message,
        state: "attempt-started",
        attempts: message.attempts + 1,
      }));
    case "AttemptDeclined":
      return mapMessage({ ...role, inFlight: undefined }, action.id, (message) =>
        message.state === "attempt-started" || message.state === "converging"
          ? { ...message, state: "queued" }
          : message,
      );
    case "AttemptUncertain":
      return mapMessage({ ...role, inFlight: undefined }, action.id, (message) => ({
        ...message,
        state: "uncertain",
      }));
    case "UserAccepted":
      // Acceptance resolves an attempt in flight and also an attempt a restart
      // left uncertain: a later exact user event under the intended identity is
      // allowed to settle that uncertainty.
      return recordEvent(
        mapMessage(role, action.id, (message) =>
          message.state === "attempt-started" || message.state === "uncertain"
            ? { ...message, state: "accepted" }
            : message,
        ),
        {
          kind: "user-accepted",
          key: action.eventKey,
          identity: action.identity,
          text: action.text,
          turn: action.turn,
        },
      );
    case "AssistantObserved":
      return recordEvent(role, {
        kind: "assistant-output",
        key: action.eventKey,
        identity: action.identity,
        text: action.text,
        turn: action.turn,
      });
    case "AssistantCompleted":
      return recordEvent(
        mapMessage({ ...role, inFlight: undefined }, action.id, (message) =>
          message.state === "accepted" ? { ...message, state: "completed" } : message,
        ),
        {
          kind: "turn-completed",
          key: action.eventKey,
          identity: action.identity,
          text: "",
          turn: action.turn,
        },
      );
    case "ObserverAdvanced":
      return { ...role, cursor: action.cursor, observerSource: action.source };
    case "PaneUnavailable":
      return { ...role, readiness: "unavailable" };
    case "ObserverRefused":
      return role;
  }
}

/** Append a normalized event unless one with the same key is already present. */
function recordEvent(role: RoleState, event: NormalizedEvent): RoleState {
  if (role.events.some((existing) => existing.key === event.key)) {
    return role;
  }
  return { ...role, events: [...role.events, event] };
}

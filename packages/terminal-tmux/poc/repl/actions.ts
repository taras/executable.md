/**
 * Issue #774 POC — the fixed action vocabulary.
 *
 * Actions are the only way the REPL store changes. The vocabulary is closed:
 * every transition the REPL, the delivery worker and the two session-file
 * observers can cause is one of the shapes below, and the reducer in
 * `state.ts` is the only place they are applied.
 *
 * Each action is a plain value with a `type` discriminant. The store stamps a
 * monotonic sequence number onto every one it accepts and persists it under
 * that number, so the retained history is an ordered, gap-free log that replays
 * to the exact state the run held.
 */

import type { NativeIdentity, Readiness } from "./state.ts";

/** The one action that has no role: opening the REPL session itself. */
export interface ReplOpened {
  readonly type: "ReplOpened";
  readonly replSession: string;
}

/** Bind one authored role to its native identity and initial pane generation. */
export interface RoleBound {
  readonly type: "RoleBound";
  readonly key: string;
  readonly role: string;
  readonly issue: string;
  readonly identity: NativeIdentity;
  readonly paneGeneration: number;
}

/** A message the operator asked to send, queued behind any earlier work. */
export interface MessageQueued {
  readonly type: "MessageQueued";
  readonly key: string;
  readonly id: string;
  readonly text: string;
  readonly marker: string;
}

/** Terminal convergence reported a readiness for a role's pane. */
export interface TerminalObserved {
  readonly type: "TerminalObserved";
  readonly key: string;
  readonly readiness: Readiness;
}

/** The provider observer reports an open turn: the pane must not be written to. */
export interface ProviderBusy {
  readonly type: "ProviderBusy";
  readonly key: string;
}

/** The provider observer reports no open turn. */
export interface ProviderIdle {
  readonly type: "ProviderIdle";
  readonly key: string;
}

/** Convergence began for the queue head. */
export interface ConvergenceStarted {
  readonly type: "ConvergenceStarted";
  readonly key: string;
  readonly id: string;
}

/** A convergence attempt was invalidated before any byte was sent. */
export interface ConvergenceInvalidated {
  readonly type: "ConvergenceInvalidated";
  readonly key: string;
  readonly id: string;
  readonly reason: string;
}

/**
 * The intent to deliver, recorded durably *before* the first terminal byte.
 *
 * This is the record a restart reads to know an outcome is uncertain rather
 * than un-attempted.
 */
export interface AttemptStarted {
  readonly type: "AttemptStarted";
  readonly key: string;
  readonly id: string;
}

/** The final server-side guard declined the paste; nothing was sent. */
export interface AttemptDeclined {
  readonly type: "AttemptDeclined";
  readonly key: string;
  readonly id: string;
  readonly reason: string;
}

/** An attempt whose outcome could not be established; never retried. */
export interface AttemptUncertain {
  readonly type: "AttemptUncertain";
  readonly key: string;
  readonly id: string;
  readonly reason: string;
}

/** The exact attempted bytes were observed as a user event under the identity. */
export interface UserAccepted {
  readonly type: "UserAccepted";
  readonly key: string;
  readonly id: string;
  readonly eventKey: string;
  readonly identity: string;
  readonly text: string;
}

/** Assistant output observed under the intended identity. */
export interface AssistantObserved {
  readonly type: "AssistantObserved";
  readonly key: string;
  readonly eventKey: string;
  readonly identity: string;
  readonly text: string;
}

/** An explicit provider completion boundary closed the turn. */
export interface AssistantCompleted {
  readonly type: "AssistantCompleted";
  readonly key: string;
  readonly id: string;
  readonly eventKey: string;
  readonly identity: string;
}

/** The observer cursor advanced past a complete, strictly parsed record. */
export interface ObserverAdvanced {
  readonly type: "ObserverAdvanced";
  readonly key: string;
  readonly cursor: number;
  readonly source: string;
}

/** The pane exited or was replaced; the role is no longer writable. */
export interface PaneUnavailable {
  readonly type: "PaneUnavailable";
  readonly key: string;
  readonly reason: string;
}

/** The observer refused to advance: ambiguity, truncation, rotation, mismatch. */
export interface ObserverRefused {
  readonly type: "ObserverRefused";
  readonly key: string;
  readonly reason: string;
}

/** The REPL session closed. */
export interface ReplClosed {
  readonly type: "ReplClosed";
}

/** The whole closed vocabulary. */
export type ReplAction =
  | ReplOpened
  | RoleBound
  | MessageQueued
  | TerminalObserved
  | ProviderBusy
  | ProviderIdle
  | ConvergenceStarted
  | ConvergenceInvalidated
  | AttemptStarted
  | AttemptDeclined
  | AttemptUncertain
  | UserAccepted
  | AssistantObserved
  | AssistantCompleted
  | ObserverAdvanced
  | PaneUnavailable
  | ObserverRefused
  | ReplClosed;

/** Every action type name, for a persisted record to be validated against. */
export const ACTION_TYPES: readonly ReplAction["type"][] = [
  "ReplOpened",
  "RoleBound",
  "MessageQueued",
  "TerminalObserved",
  "ProviderBusy",
  "ProviderIdle",
  "ConvergenceStarted",
  "ConvergenceInvalidated",
  "AttemptStarted",
  "AttemptDeclined",
  "AttemptUncertain",
  "UserAccepted",
  "AssistantObserved",
  "AssistantCompleted",
  "ObserverAdvanced",
  "PaneUnavailable",
  "ObserverRefused",
  "ReplClosed",
];

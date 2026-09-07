/**
 * Issue #774 POC — the controller that drives the message lifecycle.
 *
 * It is the only place that reads convergence, delivery and the observer
 * together, and every effect it has on the world is a dispatched action:
 *
 * - `attemptStep` takes one role's queue head from `queued` to a pasted attempt,
 *   through convergence and the final guard, recording `AttemptStarted` durably
 *   before a single byte is sent. A pane that is unavailable, replaced, busy, or
 *   moving keeps the message queued.
 * - `observeStep` reads the provider session file forward from the durable
 *   cursor and turns exact matching records into acceptance and completion. A
 *   refusal advances no cursor.
 * - `reconcileRestart` turns any attempt a restart left in flight into an
 *   `uncertain` outcome that is never pasted again, though a later exact provider
 *   event may still resolve it.
 *
 * Terminal convergence only ever authorizes an attempt. Acceptance and
 * completion come from the provider file, and an unproved outcome becomes
 * uncertain rather than delivered.
 */

import type { Operation } from "effection";
import { converge } from "./convergence.ts";
import type { PaneProbe } from "./convergence.ts";
import { deliver } from "./delivery.ts";
import { hasOpenTurn, locate, read } from "./observer.ts";
import type { ObservationRefusal, ProviderParser } from "./observer.ts";
import { queueHead } from "./state.ts";
import type { NormalizedEvent, RoleState } from "./state.ts";
import type { ReplStore } from "./store.ts";

/** Where a provider's session files for one role are found and read. */
export interface ObserverSource {
  readonly parser: ProviderParser;
  /** The directory the provider writes its session files under. */
  readonly directory: string;
}

/** How a delivery attempt is shaped for one role's pane. */
export interface DeliveryOptions {
  /** The private mode-`0700` directory message files are staged under. */
  readonly messageDir: string;
  readonly bracketedPaste: boolean;
  readonly submitKey: string;
}

/** What one attempt step did. */
export type AttemptResult =
  | {
      readonly outcome: "pasted";
      readonly id: string;
      readonly byteCount: number;
      readonly hash: string;
    }
  | { readonly outcome: "declined"; readonly id: string; readonly reason: string }
  | { readonly outcome: "not-ready"; readonly id: string; readonly reason: string }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal }
  | { readonly outcome: "skipped"; readonly reason: string };

/** What one observation step did. */
export type ObserveResult =
  | { readonly outcome: "advanced"; readonly events: readonly NormalizedEvent[] }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

/** The message a role currently has in flight, if any. */
function inFlightMessage(role: RoleState) {
  return role.inFlight === undefined
    ? undefined
    : role.messages.find((message) => message.id === role.inFlight);
}

/** The one message currently accepted and awaiting completion, if any. */
function acceptedMessage(role: RoleState) {
  return role.messages.find((message) => message.state === "accepted");
}

/**
 * Try to deliver one role's queue head.
 *
 * The order is the contract: prove the pane usable and the same across a
 * barrier, prove the provider idle, record the intent, then paste under a final
 * guard. Anything unproved leaves the message exactly where it was.
 */
export function attemptStep(
  store: ReplStore,
  key: string,
  probe: PaneProbe,
  observer: ObserverSource,
  options: DeliveryOptions,
): Operation<AttemptResult> {
  return (function* (): Operation<AttemptResult> {
    const role = store.state().roles[key];
    if (role === undefined) {
      return { outcome: "skipped", reason: "unknown-role" };
    }
    if (role.readiness === "unavailable") {
      return { outcome: "skipped", reason: "pane-unavailable" };
    }
    if (role.inFlight !== undefined) {
      return { outcome: "skipped", reason: "in-flight" };
    }
    const head = queueHead(role);
    if (head === undefined) {
      return { outcome: "skipped", reason: "queue-empty" };
    }

    const open = yield* providerOpenTurn(observer, role.identity.id);
    if (open.outcome === "refused") {
      yield* store.dispatch({ type: "ObserverRefused", key, reason: open.refusal });
      return { outcome: "refused", refusal: open.refusal };
    }

    // A pane whose generation moved is a replacement, never silently adopted.
    const current = yield* probe.snapshot();
    if (current.generation !== role.paneGeneration) {
      yield* store.dispatch({ type: "PaneUnavailable", key, reason: "pane-replaced" });
      return { outcome: "not-ready", id: head.id, reason: "pane-replaced" };
    }

    yield* store.dispatch({ type: "ConvergenceStarted", key, id: head.id });
    const converged = yield* converge(probe, open.openTurn);
    if (converged.outcome === "not-ready") {
      yield* store.dispatch({
        type: "ConvergenceInvalidated",
        key,
        id: head.id,
        reason: converged.reason,
      });
      if (converged.reason === "provider-open-turn") {
        yield* store.dispatch({ type: "ProviderBusy", key });
      }
      if (converged.reason === "pane-unavailable") {
        yield* store.dispatch({ type: "PaneUnavailable", key, reason: "pane-exit" });
      }
      return { outcome: "not-ready", id: head.id, reason: converged.reason };
    }
    if (converged.guard.generation !== role.paneGeneration) {
      yield* store.dispatch({ type: "PaneUnavailable", key, reason: "pane-replaced" });
      return { outcome: "not-ready", id: head.id, reason: "pane-replaced" };
    }

    yield* store.dispatch({ type: "TerminalObserved", key, readiness: "ready" });
    // The durable intent, before any byte reaches the terminal.
    yield* store.dispatch({ type: "AttemptStarted", key, id: head.id });

    const delivered = yield* deliver(probe, {
      dir: options.messageDir,
      id: head.id,
      bytes: head.text,
      bracketedPaste: options.bracketedPaste,
      submitKey: options.submitKey,
      guard: converged.guard,
    });
    if (delivered.outcome === "declined") {
      yield* store.dispatch({
        type: "AttemptDeclined",
        key,
        id: head.id,
        reason: delivered.reason,
      });
      return { outcome: "declined", id: head.id, reason: delivered.reason };
    }
    return {
      outcome: "pasted",
      id: head.id,
      byteCount: delivered.byteCount,
      hash: delivered.hash,
    };
  })();
}

/**
 * Read the provider session file forward and turn records into state.
 *
 * A located file is read from the durable cursor. Exact matching user records
 * settle an attempt as accepted; assistant output and the completion boundary
 * that follow settle it as completed. A refusal advances no cursor and leaves
 * every message where it was.
 */
export function observeStep(
  store: ReplStore,
  key: string,
  observer: ObserverSource,
): Operation<ObserveResult> {
  return (function* (): Operation<ObserveResult> {
    const role = store.state().roles[key];
    if (role === undefined) {
      return { outcome: "refused", refusal: "not-found" };
    }
    const located = yield* locate(observer.parser, observer.directory, role.identity.id);
    if (located.outcome === "refused") {
      yield* store.dispatch({ type: "ObserverRefused", key, reason: located.refusal });
      return { outcome: "refused", refusal: located.refusal };
    }
    // The cursor was established against a particular file identity. Re-locating
    // finds the current file, but a change of identity since the cursor was set
    // is a rotation — so the remembered key, not the freshly located one, is
    // what `read` enforces.
    const expectedKey = role.observerSource === "" ? located.source.fileKey : role.observerSource;
    const source = { ...located.source, fileKey: expectedKey };
    const readOut = yield* read(observer.parser, source, role.cursor);
    if (readOut.outcome === "refused") {
      yield* store.dispatch({ type: "ObserverRefused", key, reason: readOut.refusal });
      return { outcome: "refused", refusal: readOut.refusal };
    }
    for (const event of readOut.events) {
      yield* applyEvent(store, key, event);
    }
    yield* store.dispatch({
      type: "ObserverAdvanced",
      key,
      cursor: readOut.cursor,
      source: located.source.fileKey,
    });
    return { outcome: "advanced", events: readOut.events };
  })();
}

/** Fold one normalized event into the store, matching it to a message. */
function applyEvent(store: ReplStore, key: string, event: NormalizedEvent): Operation<void> {
  return (function* (): Operation<void> {
    const role = store.state().roles[key];
    if (role === undefined) {
      return;
    }
    if (event.kind === "user-accepted") {
      // The exact attempted bytes, under the intended identity. A user record
      // whose text differs is someone else's turn and settles nothing.
      const target = role.messages.find(
        (message) =>
          (message.state === "attempt-started" || message.state === "uncertain") &&
          message.text === event.text,
      );
      if (target !== undefined) {
        yield* store.dispatch({
          type: "UserAccepted",
          key,
          id: target.id,
          eventKey: event.key,
          identity: event.identity,
          text: event.text,
        });
      }
      return;
    }
    const accepted = acceptedMessage(role);
    if (accepted === undefined) {
      return;
    }
    if (event.kind === "assistant-output") {
      yield* store.dispatch({
        type: "AssistantObserved",
        key,
        eventKey: event.key,
        identity: event.identity,
        text: event.text,
      });
      return;
    }
    yield* store.dispatch({
      type: "AssistantCompleted",
      key,
      id: accepted.id,
      eventKey: event.key,
      identity: event.identity,
    });
  })();
}

/**
 * Settle an attempt whose paste was accepted by tmux but never confirmed.
 *
 * Called once a bounded observation has shown no exact user event for the
 * in-flight attempt: the outcome is uncertain, and the message is never pasted
 * again. A later exact provider event may still resolve it through `observeStep`.
 */
export function settleUnconfirmed(
  store: ReplStore,
  key: string,
  reason: string,
): Operation<boolean> {
  return (function* (): Operation<boolean> {
    const role = store.state().roles[key];
    if (role === undefined) {
      return false;
    }
    const message = inFlightMessage(role);
    if (message === undefined || message.state !== "attempt-started") {
      return false;
    }
    yield* store.dispatch({ type: "AttemptUncertain", key, id: message.id, reason });
    return true;
  })();
}

/**
 * Reconcile a restarted store.
 *
 * Any attempt that was in flight when the process stopped is uncertain: tmux may
 * have accepted the paste, so it must never be pasted again. Queued work is
 * untouched and resumes convergence normally.
 */
export function reconcileRestart(store: ReplStore): Operation<number> {
  return (function* (): Operation<number> {
    let settled = 0;
    for (const role of Object.values(store.state().roles)) {
      const message = inFlightMessage(role);
      if (message !== undefined && message.state === "attempt-started") {
        yield* store.dispatch({
          type: "AttemptUncertain",
          key: role.key,
          id: message.id,
          reason: "restart",
        });
        settled += 1;
      }
    }
    return settled;
  })();
}

/** Whether the provider file shows an open turn now, or a refusal to read it. */
type OpenTurnOutcome =
  | { readonly outcome: "read"; readonly openTurn: boolean }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

function providerOpenTurn(observer: ObserverSource, identity: string): Operation<OpenTurnOutcome> {
  return (function* (): Operation<OpenTurnOutcome> {
    const located = yield* locate(observer.parser, observer.directory, identity);
    if (located.outcome === "refused") {
      return { outcome: "refused", refusal: located.refusal };
    }
    const readOut = yield* read(observer.parser, located.source, 0);
    if (readOut.outcome === "refused") {
      return { outcome: "refused", refusal: readOut.refusal };
    }
    return { outcome: "read", openTurn: hasOpenTurn(readOut.events) };
  })();
}

/**
 * Issue #774 POC — the controller that drives the message lifecycle.
 *
 * It is the only place that reads convergence, delivery and the observer
 * together, and every effect it has on the world is a dispatched action:
 *
 * - `attemptStep` takes one role's queue head from `queued` to a pasted attempt.
 *   It composes convergence's combined sample from the pane probe and the
 *   provider observer, so a turn that opens during the acknowledged barrier fails
 *   convergence exactly as a pane change does. It records `AttemptStarted`
 *   durably, re-samples once more between convergence and the guard, and only then
 *   pastes under the final guard. A pane that is unavailable, replaced, busy or
 *   moving keeps the message queued; an observer that cannot map the source
 *   refuses; a paste whose whole delivery could not be proved becomes uncertain
 *   and is never retried.
 * - `observeStep` reads the provider session file forward from the durable
 *   cursor and turns exact matching records into acceptance and completion,
 *   grouped by the provider's own turn identity. A refusal advances no cursor.
 * - `reconcileRestart` turns any attempt a restart left in flight into an
 *   `uncertain` outcome that is never pasted again.
 *
 * Terminal convergence only ever authorizes an attempt. Acceptance and
 * completion come from the provider file.
 */

import type { Operation } from "effection";
import { converge, providerUnchanged, structurallyEqual } from "./convergence.ts";
import type { PaneProbe, SampleResult } from "./convergence.ts";
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
  /** The exact temporary project the launch ran in, constraining the match. */
  readonly project: string;
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
  | { readonly outcome: "uncertain"; readonly id: string; readonly reason: string }
  | { readonly outcome: "not-ready"; readonly id: string; readonly reason: string }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal }
  | { readonly outcome: "skipped"; readonly reason: string };

/** What one observation step did. */
export type ObserveResult =
  | { readonly outcome: "advanced"; readonly events: readonly NormalizedEvent[] }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

/** Every observer refusal, so a convergence reason can be recognized as one. */
const REFUSALS: ReadonlySet<string> = new Set<ObservationRefusal>([
  "not-found",
  "identity-ambiguous",
  "identity-mismatch",
  "truncation",
  "rotation",
  "unsupported-shape",
]);

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

/** The provider turn the accepted message was accepted under, when grouped. */
function acceptedTurn(role: RoleState, text: string): string | undefined {
  const event = role.events.find(
    (candidate) => candidate.kind === "user-accepted" && candidate.text === text,
  );
  return event?.turn;
}

/** Two turns match when both are absent (a linear thread) or exactly equal. */
function turnMatches(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

/** How the provider file reads now: idle/open, its length, its event count. */
type ProviderReadResult =
  | {
      readonly outcome: "read";
      readonly openTurn: boolean;
      readonly cursor: number;
      readonly eventCount: number;
    }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

/** Read the whole provider file's relevant state, or a refusal to read it. */
function readProvider(observer: ObserverSource, identity: string): Operation<ProviderReadResult> {
  return (function* (): Operation<ProviderReadResult> {
    const located = yield* locate(observer.parser, observer.directory, identity, observer.project);
    if (located.outcome === "refused") {
      return { outcome: "refused", refusal: located.refusal };
    }
    const readOut = yield* read(observer.parser, located.source, 0);
    if (readOut.outcome === "refused") {
      return { outcome: "refused", refusal: readOut.refusal };
    }
    return {
      outcome: "read",
      openTurn: hasOpenTurn(readOut.events),
      cursor: readOut.cursor,
      eventCount: readOut.events.length,
    };
  })();
}

/** The combined pane+provider sampler convergence and the final recheck use. */
function makeSampler(
  probe: PaneProbe,
  observer: ObserverSource,
  identity: string,
): () => Operation<SampleResult> {
  return function* (): Operation<SampleResult> {
    const pane = yield* probe.snapshot();
    const provider = yield* readProvider(observer, identity);
    if (provider.outcome === "refused") {
      return { outcome: "unreadable", reason: provider.refusal };
    }
    return {
      outcome: "sampled",
      sample: {
        pane,
        provider: {
          openTurn: provider.openTurn,
          cursor: provider.cursor,
          eventCount: provider.eventCount,
        },
      },
    };
  };
}

/**
 * Try to deliver one role's queue head.
 *
 * The order is the contract: prove the pane usable and the same across a
 * barrier, prove the provider idle and unchanged across it, record the intent,
 * re-sample once more, then paste under a final guard. Anything unproved leaves
 * the message queued; a paste that cannot be fully proved leaves it uncertain.
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

    // A pane whose generation moved is a replacement, never silently adopted.
    const current = yield* probe.snapshot();
    if (current.generation !== role.paneGeneration) {
      yield* store.dispatch({ type: "PaneUnavailable", key, reason: "pane-replaced" });
      return { outcome: "not-ready", id: head.id, reason: "pane-replaced" };
    }

    yield* store.dispatch({ type: "ConvergenceStarted", key, id: head.id });
    const sampler = makeSampler(probe, observer, role.identity.id);
    const converged = yield* converge(sampler, () => probe.barrier());
    if (converged.outcome === "not-ready") {
      // An observer that could not map the source is a refusal, distinct from a
      // pane that was merely busy or moving.
      const refusal = asRefusal(converged.reason);
      if (refusal !== undefined) {
        // Reset the queue head from `converging` before reporting the refusal.
        yield* store.dispatch({
          type: "ConvergenceInvalidated",
          key,
          id: head.id,
          reason: converged.reason,
        });
        yield* store.dispatch({ type: "ObserverRefused", key, reason: refusal });
        return { outcome: "refused", refusal };
      }
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
    if (converged.guard.pane.generation !== role.paneGeneration) {
      yield* store.dispatch({ type: "PaneUnavailable", key, reason: "pane-replaced" });
      return { outcome: "not-ready", id: head.id, reason: "pane-replaced" };
    }

    yield* store.dispatch({ type: "TerminalObserved", key, readiness: "ready" });
    // The durable intent, before any byte reaches the terminal.
    yield* store.dispatch({ type: "AttemptStarted", key, id: head.id });

    // One more combined read between convergence and the guard. A turn that
    // opened, a record that appeared, an identity that changed, or a pane that
    // moved in this window declines the attempt with nothing sent.
    const recheck = yield* sampler();
    if (
      recheck.outcome === "unreadable" ||
      recheck.sample.provider.openTurn ||
      !providerUnchanged(recheck.sample.provider, converged.guard.provider) ||
      !structurallyEqual(recheck.sample.pane, converged.guard.pane) ||
      recheck.sample.pane.epoch !== converged.guard.pane.epoch
    ) {
      const reason =
        recheck.outcome === "unreadable" ? recheck.reason : "provider-or-pane-changed-before-guard";
      yield* store.dispatch({ type: "AttemptDeclined", key, id: head.id, reason });
      return { outcome: "declined", id: head.id, reason };
    }

    const delivered = yield* deliver(probe, {
      dir: options.messageDir,
      id: head.id,
      bytes: head.text,
      bracketedPaste: options.bracketedPaste,
      submitKey: options.submitKey,
      guard: converged.guard.pane,
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
    if (delivered.outcome === "uncertain") {
      // Bytes may have reached the terminal but the whole delivery is unproved:
      // uncertain, and never pasted again.
      yield* store.dispatch({
        type: "AttemptUncertain",
        key,
        id: head.id,
        reason: delivered.reason,
      });
      return { outcome: "uncertain", id: head.id, reason: delivered.reason };
    }
    return {
      outcome: "pasted",
      id: head.id,
      byteCount: delivered.byteCount,
      hash: delivered.hash,
    };
  })();
}

/** The observer refusal a convergence `provider-…` reason names, if any. */
function asRefusal(reason: string): ObservationRefusal | undefined {
  const stripped = reason.startsWith("provider-") ? reason.slice("provider-".length) : reason;
  return REFUSALS.has(stripped) ? (stripped as ObservationRefusal) : undefined;
}

/**
 * Read the provider session file forward and turn records into state.
 *
 * A located file is read from the durable cursor. Exact matching user records
 * settle an attempt as accepted; assistant output and the completion boundary
 * that follow — grouped by the same provider turn — settle it as completed. A
 * refusal advances no cursor and leaves every message where it was.
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
    const located = yield* locate(
      observer.parser,
      observer.directory,
      role.identity.id,
      observer.project,
    );
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

/** Fold one normalized event into the store, matching it to a message and turn. */
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
          ...(event.turn === undefined ? {} : { turn: event.turn }),
        });
      }
      return;
    }
    const accepted = acceptedMessage(role);
    if (accepted === undefined) {
      return;
    }
    // Assistant output and completion belong to the accepted message only when
    // they are part of the same provider turn.
    if (!turnMatches(event.turn, acceptedTurn(role, accepted.text))) {
      return;
    }
    if (event.kind === "assistant-output") {
      yield* store.dispatch({
        type: "AssistantObserved",
        key,
        eventKey: event.key,
        identity: event.identity,
        text: event.text,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
      });
      return;
    }
    yield* store.dispatch({
      type: "AssistantCompleted",
      key,
      id: accepted.id,
      eventKey: event.key,
      identity: event.identity,
      ...(event.turn === undefined ? {} : { turn: event.turn }),
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

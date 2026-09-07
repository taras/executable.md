/**
 * Issue #774 POC — the generic terminal-convergence algorithm.
 *
 * The unproven boundary this whole experiment exists for: can generic terminal
 * state identify a safe point to deliver input without parsing what the agent
 * drew on the screen? The algorithm below reads only structural facts about a
 * pane — its generation, its process, its terminal, whether it is in a mode,
 * how much output and client activity it has seen — plus whether the provider's
 * own session file shows an open turn. It never reads prompt wording or screen
 * text.
 *
 * Convergence authorizes an *attempt*. It never establishes acceptance: only the
 * provider session file does that. Two structurally equal snapshots separated by
 * an acknowledged terminal barrier, with no intervening event and no open
 * provider turn, are what "ready" means here.
 *
 * A `PaneProbe` is the seam. The tmux provider would implement it over a private
 * control-mode client; the deterministic suite implements it with a fake pane
 * that also holds hidden busy and manual ground truth — exposed only to the
 * assertions, never to this algorithm.
 */

import type { Operation } from "effection";

/** A structural reading of one pane. No screen text appears here. */
export interface PaneSnapshot {
  /** The pane generation; a replacement bumps it, and an old one is refused. */
  readonly generation: number;
  /** The pane's foreground process id, or a non-positive value when dead. */
  readonly pid: number;
  /** The pane's terminal identity, or "" when it has none. */
  readonly terminal: string;
  readonly alive: boolean;
  /** The pane's input mode: "" is the ordinary input mode, else copy-mode etc. */
  readonly mode: string;
  /** The foreground process group leader, distinguishing a child from the shell. */
  readonly foregroundProcess: number;
  /** A generation that advances whenever a visible client acts. */
  readonly clientActivity: number;
  /** A count of control-mode output events, with the output bytes dropped. */
  readonly outputEvents: number;
  /** A counter that advances on *any* observable pane event. */
  readonly epoch: number;
}

/** A literal paste, described without any bytes crossing an argument vector. */
export interface PasteRequest {
  /** The uniquely named tmux buffer the message bytes were loaded into. */
  readonly buffer: string;
  /** Whether bracketed paste is used, when the terminal supports it. */
  readonly bracketedPaste: boolean;
  /** The submit key, sent separately from the pasted bytes. */
  readonly submitKey: string;
}

/** What the one guarded paste operation established. */
export type GuardOutcome =
  | { readonly outcome: "pasted" }
  | { readonly outcome: "declined"; readonly reason: string };

/**
 * The pane operations convergence and delivery need.
 *
 * Everything here is a structural tmux-shaped verb. `guardedPaste` is the single
 * server-side operation that rechecks the pane and either declines or pastes
 * without suspending in between — the last gate before bytes reach a terminal.
 */
export interface PaneProbe {
  /** Read the pane's current structural state. */
  snapshot(): Operation<PaneSnapshot>;
  /** An acknowledged terminal round-trip, so two snapshots straddle a barrier. */
  barrier(): Operation<void>;
  /** Load the private message file's bytes into a uniquely named buffer. */
  loadBuffer(buffer: string, path: string): Operation<void>;
  /**
   * Recheck the pane against the converged guard and paste, or decline — in one
   * operation, with no suspension between the recheck and the paste.
   */
  guardedPaste(guard: PaneSnapshot, delivery: PasteRequest): Operation<GuardOutcome>;
}

/** The result of one convergence attempt. */
export type ConvergenceOutcome =
  | { readonly outcome: "converged"; readonly guard: PaneSnapshot }
  | { readonly outcome: "not-ready"; readonly reason: string };

/**
 * Attempt to converge one pane to a safe input point.
 *
 * Takes a snapshot, requires the pane usable and the provider idle, crosses an
 * acknowledged barrier, and takes a second snapshot. It converges only when the
 * two are structurally equal and no event occurred between them. Any difference
 * — including the epoch advancing, which is any observable event at all — is
 * `not-ready`, and the caller leaves the message queued.
 */
export function converge(
  probe: PaneProbe,
  providerOpenTurn: boolean,
): Operation<ConvergenceOutcome> {
  return (function* (): Operation<ConvergenceOutcome> {
    if (providerOpenTurn) {
      return { outcome: "not-ready", reason: "provider-open-turn" };
    }
    const first = yield* probe.snapshot();
    const usable = usability(first);
    if (usable !== undefined) {
      return { outcome: "not-ready", reason: usable };
    }
    yield* probe.barrier();
    const second = yield* probe.snapshot();
    if (!structurallyEqual(first, second)) {
      return { outcome: "not-ready", reason: "pane-changed" };
    }
    if (second.epoch !== first.epoch) {
      return { outcome: "not-ready", reason: "intervening-event" };
    }
    return { outcome: "converged", guard: second };
  })();
}

/** Why a pane is not usable for a delivery attempt, or nothing when it is. */
function usability(snapshot: PaneSnapshot): string | undefined {
  if (!snapshot.alive || snapshot.pid <= 0 || snapshot.terminal.length === 0) {
    return "pane-unavailable";
  }
  if (snapshot.mode.length > 0) {
    return "pane-in-mode";
  }
  return undefined;
}

/** Whether two snapshots agree on every structural fact but the event epoch. */
export function structurallyEqual(left: PaneSnapshot, right: PaneSnapshot): boolean {
  return (
    left.generation === right.generation &&
    left.pid === right.pid &&
    left.terminal === right.terminal &&
    left.alive === right.alive &&
    left.mode === right.mode &&
    left.foregroundProcess === right.foregroundProcess &&
    left.clientActivity === right.clientActivity &&
    left.outputEvents === right.outputEvents
  );
}

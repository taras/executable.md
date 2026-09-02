/**
 * Who is allowed to own a terminal, and what "ready" means (architecture.md
 * §Terminal authority).
 *
 * The provider draws a grid. This decides everything about it that matters:
 * which request is live, which provider installation it belongs to, which pane
 * ordinals exist, whether an interactive operation may start on one, and when a
 * pane has actually started. None of that is reachable by name. There is no
 * context holding an authority, no member of a request that carries one, and no
 * handler return value that produces one — an authority reachable by name would
 * be an authority every same-name context and every loaded copy could reach.
 *
 * A claim is the unforgeable carrier. It is minted here for one ordinal of one
 * request under one installation generation, and a claim from another grid,
 * another ordinal, an earlier generation, or a finished expansion authorizes
 * nothing at all. Holding one grants terminal ownership and nothing else: it
 * says nothing about which Agent session a pane may own, because that is the
 * session coordinator's to answer and stays independently authoritative.
 */

import { all, ensure, withResolvers } from "effection";
import type { Operation } from "effection";
import type { TerminalGridRequest } from "@executablemd/runtime";

export class TerminalAuthorityError extends Error {
  override name = "TerminalAuthorityError";
}

/**
 * One pane's terminal ownership.
 *
 * `admit` is the whole of it: an interactive operation runs inside one, and a
 * second one on the same pane is refused while the first is live. Two claims for
 * two ordinals do not contend at all, which is what lets panes be interactive at
 * the same time.
 */
export interface TerminalPaneClaim {
  readonly ordinal: number;
  /**
   * Run one interactive operation as this pane's owner.
   *
   * Refuses while another is live on this pane, and refuses once the grid that
   * minted the claim has finished — a claim kept past its expansion is a claim
   * to a terminal nobody owns any more.
   */
  admit<T>(body: () => Operation<T>): Operation<T>;
  /**
   * Acknowledge the runtime's successful child-spawn event for this pane.
   *
   * The one thing that makes a pane ready. Called from the spawn event and
   * before anything waits for the child to exit, so a child that starts and
   * immediately exits is both ready and settled. Acknowledging twice has no
   * effect, and a preparation, reservation or spawn that failed never
   * acknowledges at all.
   */
  ready(): void;
}

/** What one pane's readiness is waiting on, from the grid's side. */
export interface PaneReadiness {
  /** Settles when the pane's first interactive child reports its spawn event. */
  reached(): Operation<void>;
  /** Whether the latch has been acknowledged. */
  readonly acknowledged: boolean;
}

/** The claims one grid expansion holds, and what they are waiting on. */
export interface TerminalGridClaims {
  readonly claims: readonly TerminalPaneClaim[];
  readonly readiness: readonly PaneReadiness[];
  /**
   * Stop admitting anything on every pane.
   *
   * Close prevents a later launch before it cancels the live ones, so a pane
   * that was about to start one is refused rather than raced.
   */
  seal(): void;
}

/**
 * Mint the claims for one grid expansion.
 *
 * The request is validated against the ordinals it declares before a single
 * claim exists: a request whose panes are not exactly `0..n-1` in order
 * describes a grid core did not derive, and answering it would be answering for
 * a layout nobody authored.
 */
export function createTerminalGridClaims(request: TerminalGridRequest): TerminalGridClaims {
  validate(request);

  let sealed = false;
  const claims: TerminalPaneClaim[] = [];
  const readiness: PaneReadiness[] = [];

  for (const pane of request.panes) {
    const latch = withResolvers<void>();
    let acknowledged = false;
    let live = false;

    readiness.push({
      reached: () => latch.operation,
      get acknowledged() {
        return acknowledged;
      },
    });

    claims.push({
      ordinal: pane.ordinal,
      *admit<T>(body: () => Operation<T>): Operation<T> {
        if (sealed) {
          throw new TerminalAuthorityError(
            `pane ${pane.ordinal} is closed: its grid has stopped admitting interactive work`,
          );
        }
        if (live) {
          throw new TerminalAuthorityError(
            `pane ${pane.ordinal} already has a live interactive operation — one owns a pane ` +
              `terminal at a time`,
          );
        }
        live = true;
        try {
          return yield* body();
        } finally {
          live = false;
        }
      },
      ready() {
        // Idempotent by construction: readiness is a fact about the pane, and a
        // provider that reports the same spawn twice has not started two panes.
        if (acknowledged) {
          return;
        }
        acknowledged = true;
        latch.resolve();
      },
    });
  }

  return {
    claims,
    readiness,
    seal() {
      sealed = true;
    },
  };
}

function validate(request: TerminalGridRequest): void {
  if (request.panes.length === 0) {
    throw new TerminalAuthorityError("a terminal grid request names no panes");
  }
  for (const [index, pane] of request.panes.entries()) {
    if (pane.ordinal !== index) {
      throw new TerminalAuthorityError(
        `a terminal grid request names pane ordinal ${pane.ordinal} at position ${index}: ` +
          `a pane's ordinal is its position among the grid's panes`,
      );
    }
  }
}

/**
 * Settle once every pane has reported its spawn event.
 *
 * Deliberately not a timeout: a grid has no implicit deadline, and an enclosing
 * run deadline or parent cancellation is what bounds it. A pane that fails to
 * start never reaches its latch, so the caller races this against pane failure
 * rather than asking the barrier to know about failure.
 */
export function awaitReadiness(readiness: readonly PaneReadiness[]): Operation<void> {
  return allOf(readiness.map((pane) => pane.reached()));
}

function* allOf(waits: readonly Operation<void>[]): Operation<void> {
  yield* all(waits);
}

/** Seal the grid as soon as the enclosing scope begins to unwind. */
export function sealOnTeardown(claims: TerminalGridClaims): Operation<void> {
  return ensure(() => {
    claims.seal();
  });
}

/**
 * One terminal grid, from the lease to the last finalizer (spec §6.21,
 * architecture.md §Atomic presentation and settlement).
 *
 * Opening a grid is atomic from the reader's side, and that is the whole shape
 * of this module. The composite is built while it is still hidden, every pane
 * starts concurrently, and only once all of them have actually started does
 * anything appear. A failure before that barrier discards the hidden composite
 * instead of leaving half a grid on the screen.
 *
 * Ordering is the contract, not an implementation detail:
 *
 * ```
 * lease → flush → prepare → panes start → readiness barrier → attach
 *       → panes settle independently → reader closes → teardown → lease released
 * ```
 *
 * Nothing here decides what a pane *is* — the layout arrived already derived,
 * and the work each pane does is supplied by the caller. What this owns is
 * whose terminal it is, when a pane counts as started, what happens when one
 * fails, and the order in which it all comes apart.
 */

import { ensure, race, scoped, spawn, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { flushOutput, prepareTerminalGrid, reserveTerminal } from "@executablemd/runtime";
import type { TerminalComposite, TerminalGridRequest } from "@executablemd/runtime";

import { awaitReadiness, createTerminalGridClaims } from "./authority.ts";
import type { TerminalPaneClaim } from "./authority.ts";
import type { TerminalGridLayout } from "../terminal-grid.ts";

/** How one pane ended. */
export type PaneOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: Error }
  /** Live when the reader closed the grid. Cancellation, not failure. */
  | { readonly kind: "closed" };

/**
 * What one pane does once its claim exists.
 *
 * The caller supplies this because a pane's work is the document's: a paired
 * pane expands its authored content, and a self-closing one runs the host's
 * default shell. Both run as the pane's admitted owner, and both are expected
 * to report a spawn through the claim before anything can attach.
 */
export interface PaneWork {
  readonly ordinal: number;
  run(claim: TerminalPaneClaim, composite: TerminalComposite): Operation<void>;
}

/** Everything the grid settled, in authored pane order. */
export interface GridResult {
  readonly outcomes: readonly PaneOutcome[];
  /** Why the grid failed, which is the first failed pane in authored order. */
  readonly failure?: Error;
}

/**
 * What a pane that never reported a spawn says.
 *
 * A pane whose work finished without ever starting something interactive has
 * not started: presenting it as a running pane would be presenting a grid the
 * reader cannot use.
 */
export function paneNeverStartedMessage(ordinal: number, title: string): string {
  return (
    `pane ${ordinal} ("${title}") finished without starting anything interactive, so the ` +
    `grid never opened. A pane runs an interactive child — a <Session.Launch>, or the ` +
    `default shell a self-closing <Terminal /> starts.`
  );
}

class PaneStartupError extends Error {
  override name = "PaneStartupError";
  readonly ordinal: number;
  constructor(ordinal: number, message: string) {
    super(message);
    this.ordinal = ordinal;
  }
}

/**
 * Run one grid to completion and report what its panes settled to.
 *
 * The foreground lease and the composite are both scope-owned, so every path
 * out of here — success, failure, and cancellation alike — releases the
 * terminal and destroys exactly the composite that was prepared. That is why
 * teardown is not written as a step: there is no path that can skip it.
 */
export function runTerminalGrid(
  layout: TerminalGridLayout,
  work: readonly PaneWork[],
): Operation<GridResult> {
  return scoped(function* (): Operation<GridResult> {
    const request = toRequest(layout);

    // The one foreground-terminal lease. A root <Session.Launch> and a grid
    // contend for exactly this, so neither can begin while the other holds it,
    // and a host with no terminal refuses here — before any pane has done work.
    yield* reserveTerminal();
    // Everything the document has produced so far reaches the reader before the
    // grid covers it up.
    yield* flushOutput();

    const composite = yield* prepareTerminalGrid(request);
    // Registered before a single pane starts: a composite that was prepared is
    // owed a destroy even if the next line is what fails.
    yield* ensure(() => composite.destroy());

    const grid = createTerminalGridClaims(request);
    // Nothing new is admitted once teardown begins, so a pane that was about to
    // start an interactive child is refused rather than racing the close.
    yield* ensure(() => {
      grid.seal();
    });

    const outcomes: (PaneOutcome | undefined)[] = work.map(() => undefined);
    const startupFailed = withResolvers<never>();
    let attached = false;

    const panes: Task<void>[] = [];
    for (const [index, pane] of work.entries()) {
      const claim = grid.claims[index]!;
      const readiness = grid.readiness[index]!;
      yield* composite.update(pane.ordinal, "starting");
      panes.push(
        yield* spawn(function* () {
          try {
            yield* pane.run(claim, composite);
            if (!readiness.acknowledged) {
              // Settled without ever starting: that is a startup failure even
              // though the work itself raised nothing.
              throw new PaneStartupError(
                pane.ordinal,
                paneNeverStartedMessage(pane.ordinal, request.panes[index]!.title),
              );
            }
            outcomes[index] = { kind: "succeeded" };
            yield* composite.update(pane.ordinal, "succeeded");
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            outcomes[index] = { kind: "failed", error: failure };
            // Before the barrier a pane failure is the whole grid's: nothing has
            // been shown, so the grid fails closed rather than attaching what is
            // left. After it, the failure is this pane's status and its siblings
            // keep running.
            if (!attached) {
              startupFailed.reject(failure);
              return;
            }
            yield* composite.update(pane.ordinal, "failed");
          }
        }),
      );
    }

    // Every pane must actually have started before anything is shown. Racing
    // the barrier against startup failure is what stops a grid whose pane
    // already failed from waiting forever for a latch nothing will acknowledge.
    yield* race([awaitReadiness(grid.readiness), startupFailed.operation]);

    for (const pane of work) {
      yield* composite.update(pane.ordinal, "running");
    }
    yield* composite.attach();
    attached = true;

    // The composite stays visible after its panes settle. The reader leaving is
    // what finishes the grid, not the last pane exiting.
    yield* composite.closed();

    // Close prevents new work first, then takes the live panes down: a pane
    // cancelled by the close is `closed`, which is not a failed pane.
    grid.seal();
    for (const [index, task] of panes.entries()) {
      if (outcomes[index] === undefined) {
        yield* composite.update(work[index]!.ordinal, "closed");
        outcomes[index] = { kind: "closed" };
      }
      yield* task.halt();
    }

    const settled = outcomes.map((outcome) => outcome ?? { kind: "closed" as const });
    const failed = settled.find((outcome) => outcome.kind === "failed");
    return {
      outcomes: settled,
      ...(failed?.kind === "failed" ? { failure: failed.error } : {}),
    };
  });
}

/** The provider-neutral request one derived layout asks for. */
export function toRequest(layout: TerminalGridLayout): TerminalGridRequest {
  return {
    columns: layout.columns,
    rows: layout.rows,
    panes: layout.cells.map((cell) => ({
      ordinal: cell.ordinal,
      title: cell.title,
      row: cell.row,
      column: cell.column,
      form: cell.form,
    })),
  };
}

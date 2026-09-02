/**
 * One terminal grid, from the lease to the last finalizer (spec §6.21,
 * architecture.md §Atomic presentation and settlement, §Durability and replay).
 *
 * Opening a grid is atomic from the reader's side, and that is the whole shape
 * of this module. The composite is built while it is still hidden, every pane
 * starts concurrently, and only once all of them have actually started does
 * anything appear. A failure before that barrier discards the hidden composite
 * instead of leaving half a grid on the screen.
 *
 * ```
 * layout recorded → lease → flush → routed to a provider → composite presented
 *   → panes start → readiness barrier → attach
 *   → panes settle independently → reader closes → teardown → lease released
 * ```
 *
 * Each pane is a **durable child coroutine** of the grid, allocated in authored
 * order. That is not decoration: a completed child short-circuits on replay by
 * returning its retained result without running, and claiming a completed
 * parent claims every descendant history beneath it. Wrapping the region in one
 * durable operation instead would leave the panes' entries unconsumed and
 * desynchronise the journal on the next run.
 */

import { all, ensure, race, scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { DurableContext, durableAll, ephemeral } from "@executablemd/durable-streams";
import type { Json, Workflow } from "@executablemd/durable-streams";
import { flushOutput, reserveTerminal, TerminalGrids } from "@executablemd/runtime";
import type { TerminalComposite, TerminalGridRequest } from "@executablemd/runtime";

import {
  awaitReadiness,
  createTerminalGridClaims,
  TerminalAuthorityError,
  terminalInstallation,
} from "./authority.ts";
import type { LiveGrid, TerminalPaneClaim } from "./authority.ts";
import type { TerminalGridLayout } from "../terminal-grid.ts";

/** How one pane ended, as the journal records it. */
export type PaneStatus = "succeeded" | "failed" | "closed";

/** How a grid ended. */
export type GridCloseKind = "reader" | "failed";

/** One pane's retained outcome: what it came to, and why when it failed. */
export interface RetainedPaneOutcome extends Record<string, Json> {
  status: PaneStatus;
  reason: string;
}

export interface RetainedPane extends Record<string, Json> {
  ordinal: number;
  title: string;
  form: string;
  row: number;
  column: number;
}

/**
 * What a grid retains: the provider-neutral layout, how it closed, and each
 * pane's outcome in authored order.
 *
 * Nothing here names a provider. No command, socket, path, process identifier,
 * session, window or pane identifier, no argv or environment, and no terminal
 * byte — none of that describes the document, it describes whichever provider
 * happened to present it, and a resumed run builds a fresh one.
 */
export interface RetainedGrid extends Record<string, Json> {
  layout: { columns: number; rows: number; panes: RetainedPane[] };
  close: GridCloseKind;
  panes: RetainedPaneOutcome[];
}

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

/** The provider-neutral request one derived layout asks for. */
export function toRequest(layout: TerminalGridLayout): TerminalGridRequest {
  return Object.freeze({
    columns: layout.columns,
    rows: layout.rows,
    panes: Object.freeze(
      layout.cells.map((cell) =>
        Object.freeze({
          ordinal: cell.ordinal,
          title: cell.title,
          row: cell.row,
          column: cell.column,
          form: cell.form,
        }),
      ),
    ),
  });
}

/** The retained shape of one request. */
export function retainedLayout(request: TerminalGridRequest): RetainedGrid["layout"] {
  return {
    columns: request.columns,
    rows: request.rows,
    panes: request.panes.map((pane) => ({
      ordinal: pane.ordinal,
      title: pane.title,
      form: pane.form,
      row: pane.row,
      column: pane.column,
    })),
  };
}

/**
 * Open one grid and report what it settled to.
 *
 * Core mints the one request for this expansion, takes the run's foreground
 * lease, flushes what the document has already produced, registers the request
 * as live, routes it through the public surface, and then reads what the
 * authority settled. The routed answer is discarded on purpose: a handler that
 * short-circuits or fabricates a return has presented nothing, and this says so
 * rather than letting the document believe a grid opened.
 */
export function openTerminalGrid(
  layout: TerminalGridLayout,
  work: readonly PaneWork[],
): Operation<RetainedGrid> {
  return scoped(function* (): Operation<RetainedGrid> {
    const installation = yield* terminalInstallation();
    if (installation === undefined) {
      throw new TerminalAuthorityError(
        "a terminal grid is available only inside a document execution with an installed " +
          "terminal provider — a grid outside one retains nothing and could not be resumed",
      );
    }

    const request = toRequest(layout);
    let settled: RetainedGrid | undefined;

    const grid: LiveGrid = {
      request,
      generation: installation.generation,
      used: false,
      settled: false,
      *run(composite) {
        settled = yield* presentGrid(request, composite, work);
        grid.settled = true;
      },
    };
    installation.registry.add(grid);
    yield* ensure(() => {
      installation.registry.remove(grid);
    });

    // The one foreground-terminal lease, taken before any provider is asked for
    // anything. A root <Session.Launch> and a grid contend for exactly this, so
    // neither can begin while the other holds it.
    yield* reserveTerminal();
    // Everything the document has produced so far reaches the reader before the
    // grid covers it up.
    yield* flushOutput();

    // Routed, and the answer thrown away.
    yield* TerminalGrids.operations.open(request);

    if (!grid.settled || settled === undefined) {
      throw new TerminalAuthorityError(
        "no terminal provider opened this grid — a handler answered without delivering the " +
          "request to a registered provider",
      );
    }
    return settled;
  });
}

/**
 * Run the grid on the composite a provider presented.
 *
 * The composite is scope-owned, so every path out of here — success, failure,
 * and cancellation alike — destroys exactly the composite that was presented.
 * That is why teardown is not written as a step: there is no path that can skip
 * it.
 */
function presentGrid(
  request: TerminalGridRequest,
  composite: TerminalComposite,
  work: readonly PaneWork[],
): Operation<RetainedGrid> {
  return scoped(function* (): Operation<RetainedGrid> {
    // Registered before a single pane starts: a composite that was presented is
    // owed a destroy even if the next line is what fails.
    yield* ensure(() => composite.destroy());

    const grid = createTerminalGridClaims(request);
    // Nothing new is admitted once teardown begins, so a pane that was about to
    // start an interactive child is refused rather than racing the close.
    yield* ensure(() => {
      grid.seal();
    });

    const outcomes: (RetainedPaneOutcome | undefined)[] = work.map(() => undefined);
    const startupFailed = withResolvers<never>();
    let attached = false;

    // Every pane's work, in authored order. The children are allocated in this
    // order too, so a pane's durable identity follows its ordinal rather than
    // the order the runtime happened to schedule it in.
    const paneWorkflows = work.map((pane, index) => {
      const claim = grid.claims[index]!;
      const readiness = grid.readiness[index]!;
      return function* (): Operation<RetainedPaneOutcome> {
        const outcome = yield* runPane(pane, claim, composite, readiness, request, index);
        outcomes[index] = outcome;
        yield* composite.update(pane.ordinal, outcome.status);
        if (outcome.status === "failed" && !attached) {
          // Before the barrier a pane failure is the whole grid's: nothing has
          // been shown, so the grid fails closed rather than attaching what is
          // left. After it, the failure is this pane's status alone.
          startupFailed.reject(new Error(outcome.reason));
        }
        return outcome;
      };
    });

    for (const pane of work) {
      yield* composite.update(pane.ordinal, "starting");
    }
    // Spawned as one task so the coordinator below can reach the readiness
    // barrier, attach, and wait for the reader while the panes are still live.
    const panes = yield* spawn(() => paneChildren(paneWorkflows));

    // Every pane must actually have started before anything is shown. Racing
    // the barrier against startup failure is what stops a grid whose pane
    // already failed from waiting forever for a latch nothing will acknowledge.
    try {
      yield* race([awaitReadiness(grid.readiness), startupFailed.operation]);
    } catch {
      // Simultaneous startup failures are selected by authored ordinal, not by
      // whichever rejected the race first.
      throw new Error(firstReason(outcomes) ?? "a terminal grid pane failed to start");
    }

    // A pane that already settled keeps the status it settled to: overwriting
    // it with `running` would tell the reader a finished pane is live.
    for (const [index, pane] of work.entries()) {
      if (outcomes[index] === undefined) {
        yield* composite.update(pane.ordinal, "running");
      }
    }
    yield* composite.attach();
    attached = true;

    // The composite stays visible after its panes settle. The reader leaving is
    // what finishes the grid, not the last pane exiting.
    yield* composite.closed();

    // Close prevents new work first, then takes the live panes down: a pane
    // cancelled by the close is `closed`, which is not a failed pane. Every
    // child is awaited here, and the provider's finalizers run in the scope's
    // own teardown after this returns — so the composite is destroyed, the
    // lease released and the following sibling started only once nothing a pane
    // acquired can still act.
    grid.seal();
    for (const [index, pane] of work.entries()) {
      if (outcomes[index] === undefined) {
        yield* composite.update(pane.ordinal, "closed");
        outcomes[index] = { status: "closed", reason: "" };
      }
    }
    yield* panes.halt();

    const settled = outcomes.map((outcome) => outcome ?? { status: "closed" as const, reason: "" });
    const reason = firstReason(settled);
    return {
      layout: retainedLayout(request),
      close: reason === undefined ? "reader" : "failed",
      panes: settled,
    };
  });
}

/** Run one pane's work and say what it came to. */
function runPane(
  pane: PaneWork,
  claim: TerminalPaneClaim,
  composite: TerminalComposite,
  readiness: { readonly acknowledged: boolean },
  request: TerminalGridRequest,
  index: number,
): Operation<RetainedPaneOutcome> {
  return (function* (): Operation<RetainedPaneOutcome> {
    try {
      yield* pane.run(claim, composite);
      if (!readiness.acknowledged) {
        // Settled without ever starting: a startup failure even though the work
        // itself raised nothing.
        return {
          status: "failed",
          reason: paneNeverStartedMessage(pane.ordinal, request.panes[index]!.title),
        };
      }
      return { status: "succeeded", reason: "" };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })();
}

/** The first failed pane's sentence in authored order, which is the grid's. */
function firstReason(outcomes: readonly (RetainedPaneOutcome | undefined)[]): string | undefined {
  return outcomes.find((outcome) => outcome?.status === "failed")?.reason;
}

/**
 * Run every pane as a durable child of the grid, in authored order.
 *
 * A pane's identity is derived from the grid's coroutine and its authored
 * ordinal, never from a title, a schedule, or a provider identifier — so a
 * resumed run restores a completed pane as its outcome without re-running it,
 * and continues an incomplete one from its own history.
 *
 * `durableAll` rather than `durableSpawn`: the latter returns a task spawned
 * inside the ephemeral effect's own scope, and that scope closes as the effect
 * resolves, so awaiting the task throws `halted`. It has no call sites or tests
 * upstream; `durableAll` is the primitive that is exercised.
 *
 * Without a journal there are no children to derive, and the work simply runs.
 */
function paneChildren(
  workflows: readonly (() => Operation<RetainedPaneOutcome>)[],
): Operation<RetainedPaneOutcome[]> {
  return (function* (): Operation<RetainedPaneOutcome[]> {
    const durable = yield* DurableContext.get();
    if (durable === undefined) {
      return yield* all(workflows.map((workflow) => workflow()));
    }
    return yield* durableAll<RetainedPaneOutcome>(
      workflows.map(
        (workflow) =>
          function* (): Workflow<RetainedPaneOutcome> {
            return yield* ephemeral(workflow());
          },
      ),
    );
  })();
}

/**
 * Run the whole grid as one durable child, and return what it retained.
 *
 * A completed grid replays by returning its retained result: the child's
 * workflow never runs, so no provider is contacted, no pane content expands and
 * no shell starts — and claiming the completed child claims every pane history
 * beneath it, so a resumed run starts nothing.
 */
export function durableGrid(live: () => Operation<RetainedGrid>): Operation<RetainedGrid> {
  return (function* (): Operation<RetainedGrid> {
    const durable = yield* DurableContext.get();
    if (durable === undefined) {
      return yield* live();
    }
    const [retained] = yield* durableAll<RetainedGrid>([
      function* (): Workflow<RetainedGrid> {
        return yield* ephemeral(live());
      },
    ]);
    return retained!;
  })();
}

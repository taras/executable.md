/**
 * A terminal provider that presents nothing and records everything.
 *
 * It opens no terminal, looks for no multiplexer, and starts no process — and
 * it answers the whole host contract, which is what makes it evidence that the
 * contract does not depend on tmux. Everything a row needs to read is a record
 * or a counter this keeps, so ordering claims are read rather than timed.
 *
 * The renderer here is the reference shape a real provider has to match: one
 * scope-owned lane, coalescing forward to the newest pending snapshot, never
 * applying an older revision after a newer one, and advancing what it has
 * applied only once the whole render effect for that snapshot has succeeded.
 */

import { ensure, race, resource, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";

import type {
  NativeLaunchOutcome,
  NativeLaunchRequest,
  TerminalActivity,
  TerminalCellId,
  TerminalCellStatus,
  TerminalGridHost,
  TerminalGridProvider,
  TerminalGridRequest,
  TerminalGridRevision,
  TerminalGridState,
  TerminalGridView,
  TerminalShellOutcome,
} from "../mod.ts";

/** What one controlled provider holds at a moment, by kind. */
export interface TerminalProviderResources {
  /** Hosts acquired and not yet released. */
  grids: number;
  /** Hosts shown and not yet released. */
  shown: number;
  /** Terminal activities acquired and not yet released. */
  activities: number;
}

/**
 * Everything one controlled provider did, in the order it did it.
 *
 * The record is the evidence: a suite reads it to prove that preparation came
 * before every cell started, that nothing was shown before the readiness
 * barrier, and that release took down exactly the host it prepared.
 */
export interface TerminalProviderLog {
  readonly events: string[];
  /** Every snapshot the renderer fully applied, in the order it applied them. */
  readonly applied: TerminalGridState[];
  /**
   * What each cell displays, by authored position, as of the last applied
   * snapshot.
   *
   * A suite reads this to prove where a cell's output went — and reads the root
   * document output to prove where it did not.
   */
  readonly shown: Map<number, string>;
  /**
   * What the provider still holds, counted rather than described.
   *
   * Each one goes up when the host takes something and down when it gives it
   * back, so a suite reads it after a run to prove nothing was stranded —
   * including after a cancellation, where the ordering of the record alone
   * would not say whether teardown finished.
   */
  readonly live: TerminalProviderResources;
}

/** A fresh, empty record. */
export function terminalProviderLog(): TerminalProviderLog {
  return {
    events: [],
    applied: [],
    shown: new Map<number, string>(),
    live: { grids: 0, shown: 0, activities: 0 },
  };
}

/**
 * What a controlled provider does instead of opening a terminal.
 *
 * Each hook is a place a suite makes something happen or go wrong: `onPrepare`
 * refuses before a host exists, `render` gates or fails one revision's render,
 * `onShow` fails the barrier, `launch` and `shell` decide what a cell's child
 * did and whether it started at all, `close` is the operation the host waits on
 * so a suite controls exactly when the reader leaves, and `fail` is the
 * background failure a suite raises while nothing is waiting on the renderer.
 */
export interface ControlledProviderOptions {
  /** Appended to as the host works, so ordering is read rather than timed. */
  readonly log?: TerminalProviderLog;
  onPrepare?: (request: TerminalGridRequest) => Operation<void>;
  onDestroy?: () => Operation<void>;
  /**
   * The render effect for one chosen snapshot.
   *
   * A suite that blocks here holds the lane, which is how coalescing becomes
   * observable: the revisions that arrive while this is blocked are subsumed by
   * the newest one, and only that one is rendered next.
   */
  render?: (state: TerminalGridState) => Operation<void>;
  onShow?: (revision: TerminalGridRevision) => Operation<void>;
  /** The terminal activity for one cell's native launch. */
  launch?: (
    position: number,
    request: NativeLaunchRequest,
  ) => TerminalActivity<NativeLaunchOutcome>;
  /**
   * The terminal activity for one cell's shell.
   *
   * A suite that wants a shell which never starts supplies one that throws
   * before it provides: the cell then never becomes ready, exactly as a real
   * spawn failure leaves it.
   */
  shell?: (position: number) => TerminalActivity<TerminalShellOutcome>;
  /** Settles when the reader leaves. Never, by default. */
  close?: () => Operation<void>;
  /**
   * Settles with a background provider failure.
   *
   * Independent of `close`: a suite uses it to fail the grid while no
   * foreground action is waiting on the renderer at all.
   */
  fail?: () => Operation<Error>;
  /**
   * Settles when the renderer should stop applying revisions.
   *
   * A lane that stops while the host is still acquired is a provider failure,
   * and this is how a suite produces one without failing a render.
   */
  stopRenderer?: () => Operation<void>;
  /**
   * Settles when the state subscription should stop delivering.
   *
   * A view that stops while the host is still acquired is a provider failure
   * too, and is reported as one. The stream's own type says it cannot close, so
   * this is how a suite reaches that report without building a value the
   * contract has no way to express.
   */
  stopSubscription?: () => Operation<void>;
}

/** An outcome that is already settled, for a child that needed no waiting. */
export function settled<T>(outcome: T): Operation<T> {
  // deno-lint-ignore require-yield
  return (function* (): Operation<T> {
    return outcome;
  })();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function subscriptionEndedMessage(): string {
  return (
    "the terminal provider's state subscription ended while its grid was still acquired: a " +
    "view that stops delivering is a provider failure, not a converged grid"
  );
}

export function rendererEndedMessage(): string {
  return (
    "the terminal provider's renderer stopped while its grid was still acquired: a lane that " +
    "stops applying revisions is a provider failure, not a converged grid"
  );
}

/**
 * One controlled provider.
 *
 * `generation` counts the hosts it has acquired, so a suite can tell a second
 * host apart from the first in the record.
 */
export function controlledTerminalProvider(
  options: ControlledProviderOptions = {},
): TerminalGridProvider {
  const log = options.log ?? terminalProviderLog();
  let generation = 0;

  return {
    host(request: TerminalGridRequest, view: TerminalGridView): Operation<TerminalGridHost> {
      return resource(function* (provide) {
        const mark = generation++;
        if (options.onPrepare) {
          yield* options.onPrepare(request);
        }
        log.events.push(`prepare:${mark}:${request.columns}x${request.rows}`);
        log.live.grids++;
        let isShown = false;

        // Registered before the host is provided, so every way out of the
        // resource runs it once: settled, failed to start, closed, failed by
        // the provider, or cancelled.
        yield* ensure(function* () {
          if (options.onDestroy) {
            yield* options.onDestroy();
          }
          log.events.push(`destroy:${mark}`);
          log.live.grids--;
          if (isShown) {
            isShown = false;
            log.live.shown--;
          }
        });

        const failure = withResolvers<Error>();
        const fail = (error: unknown): void => failure.resolve(toError(error));

        // Acquired in the host's own scope and released with it, so a
        // subscription cannot outlive the grid it describes.
        const states = yield* view.states;
        const first = yield* states.next();
        if (first.done) {
          throw new Error(subscriptionEndedMessage());
        }
        // Revision zero, received atomically with the registration that
        // produced it. The cell order it carries is how this provider maps a
        // live identity to the authored position it reports in the record.
        const order: TerminalCellId[] = first.value.cells.map((cell) => cell.cellId);
        const positionOf = (cellId: TerminalCellId): number => {
          const position = order.indexOf(cellId);
          if (position < 0) {
            throw new Error("this terminal grid host was asked about a cell it never received");
          }
          return position;
        };

        let pending: TerminalGridState | undefined = first.value;
        let applied = -1;
        const waiters = new Set<{ readonly required: number; readonly wake: () => void }>();
        let awake = withResolvers<void>();
        const nudge = (): void => {
          awake.resolve();
        };
        const statuses = new Map<number, TerminalCellStatus>();

        const satisfy = (): void => {
          for (const waiter of [...waiters]) {
            if (applied >= waiter.required) {
              waiters.delete(waiter);
              waiter.wake();
            }
          }
        };

        // The subscription pump. It keeps only the newest snapshot, because a
        // newer aggregate subsumes every older one — which is what makes
        // coalescing forward correct rather than lossy.
        function* pump(): Operation<never> {
          while (true) {
            const next = yield* states.next();
            if (next.done) {
              // The stream's type says this cannot happen, so reaching it means
              // the view came from somewhere that does not honour the contract.
              throw new Error(subscriptionEndedMessage());
            }
            if (pending === undefined || next.value.revision > pending.revision) {
              pending = next.value;
            }
            nudge();
          }
        }

        yield* spawn(function* (): Operation<void> {
          try {
            yield* race([
              pump(),
              (function* (): Operation<void> {
                yield* options.stopSubscription ? options.stopSubscription() : suspend();
              })(),
            ]);
            fail(new Error(subscriptionEndedMessage()));
          } catch (error) {
            fail(error);
          }
        });

        // One lane, and only one. It never starts two renders at once, never
        // applies a revision at or below the greatest it has completed, and
        // advances what it has applied only after the whole render effect for
        // the chosen snapshot has succeeded.
        function* renderLane(): Operation<never> {
          while (true) {
            const chosen = pending;
            if (chosen === undefined || chosen.revision <= applied) {
              // Re-armed and re-checked before suspending, so a snapshot that
              // arrived between the two is not waited for forever.
              awake = withResolvers<void>();
              if (pending !== undefined && pending.revision > applied) {
                continue;
              }
              yield* awake.operation;
              continue;
            }
            pending = undefined;
            if (options.render) {
              yield* options.render(chosen);
            }
            applied = chosen.revision;
            log.applied.push(chosen);
            log.events.push(`render:${mark}:${chosen.revision}`);
            for (const [position, cell] of chosen.cells.entries()) {
              log.shown.set(position, cell.content);
              if (statuses.get(position) !== cell.status) {
                statuses.set(position, cell.status);
                log.events.push(`status:${mark}:${position}:${cell.status}`);
              }
            }
            satisfy();
          }
        }

        yield* spawn(function* (): Operation<void> {
          try {
            yield* race([
              renderLane(),
              (function* (): Operation<void> {
                yield* options.stopRenderer ? options.stopRenderer() : suspend();
              })(),
            ]);
            fail(new Error(rendererEndedMessage()));
          } catch (error) {
            fail(error);
          }
        });

        const failHook = options.fail;
        if (failHook) {
          yield* spawn(function* (): Operation<void> {
            try {
              fail(yield* failHook());
            } catch (error) {
              fail(error);
            }
          });
        }

        const converge = (required: TerminalGridRevision): Operation<void> => ({
          *[Symbol.iterator]() {
            // Recorded before it is answered, so a suite reads *that* the grid
            // asked for a screen, and when, rather than inferring it from what
            // happened next.
            log.events.push(`converge:${mark}:${required}`);
            if (applied >= required) {
              return;
            }
            const reached = withResolvers<void>();
            const waiter = { required, wake: () => reached.resolve() };
            waiters.add(waiter);
            try {
              yield* reached.operation;
            } finally {
              waiters.delete(waiter);
            }
          },
        });

        yield* provide({
          closed: {
            *[Symbol.iterator]() {
              if (options.close) {
                yield* options.close();
              }
              log.events.push(`closed:${mark}`);
            },
          },
          failed: {
            *[Symbol.iterator]() {
              return yield* failure.operation;
            },
          },
          converge,
          *show(required: TerminalGridRevision) {
            yield* converge(required);
            if (options.onShow) {
              yield* options.onShow(required);
            }
            log.events.push(`show:${mark}:${required}`);
            isShown = true;
            log.live.shown++;
          },
          launch(cellId: TerminalCellId, nativeRequest: NativeLaunchRequest) {
            const position = positionOf(cellId);
            return resource<Operation<NativeLaunchOutcome>>(function* (provideOutcome) {
              const outcome = options.launch
                ? yield* options.launch(position, nativeRequest)
                : settled<NativeLaunchOutcome>({ exitCode: 0 });
              log.events.push(`launch:${mark}:${position}`);
              log.live.activities++;
              yield* ensure(() => {
                log.live.activities--;
              });
              yield* provideOutcome(outcome);
            });
          },
          shell(cellId: TerminalCellId) {
            const position = positionOf(cellId);
            return resource<Operation<TerminalShellOutcome>>(function* (provideOutcome) {
              const outcome = options.shell
                ? yield* options.shell(position)
                : settled<TerminalShellOutcome>({ exitCode: 0 });
              log.events.push(`shell:${mark}:${position}`);
              log.live.activities++;
              yield* ensure(() => {
                log.live.activities--;
              });
              yield* provideOutcome(outcome);
            });
          },
        });
      });
    },
  };
}

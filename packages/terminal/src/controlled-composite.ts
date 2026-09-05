/**
 * A composite that presents nothing and records everything.
 *
 * The controlled implementation of the contract in `./composite.ts`, and the
 * authority for core's grid lifecycle: it answers the whole contract — attach,
 * update, display, shell, launch, close, destroy — so a suite exercises the
 * lifecycle without a terminal, a multiplexer, or a process anywhere in it.
 *
 * It lives apart from the contract for the same reason the controlled launcher
 * does: production code must have no path to a fixture, and importing the
 * domain must not load one. It is reachable only through
 * `@executablemd/terminal/test`.
 */

import type { Operation } from "effection";
import type { NativeLaunchOutcome, NativeLaunchRequest } from "./native-launcher.ts";
import type {
  TerminalComposite,
  TerminalGridRequest,
  TerminalPaneState,
  TerminalShellOutcome,
} from "./composite.ts";

/**
 * Everything one controlled composite did, in the order it did it.
 *
 * The record is the evidence: a suite reads it to prove that preparation came
 * before every pane started, that nothing attached before the readiness
 * barrier, and that teardown destroyed exactly the composite it prepared.
 */
export interface TerminalProviderLog {
  readonly events: string[];
  /**
   * What each pane displayed, by ordinal.
   *
   * A suite reads this to prove where a pane's output went — and reads the root
   * document output to prove where it did not.
   */
  readonly shown: Map<number, string>;
  /**
   * What the provider still holds, counted rather than described.
   *
   * Each one goes up when the composite takes something and down when it gives
   * it back, so a suite reads it after a run to prove nothing was stranded —
   * including after a cancellation, where the ordering of the record alone
   * would not say whether teardown finished.
   */
  readonly live: TerminalProviderResources;
}

/** What one controlled composite holds at a moment, by kind. */
export interface TerminalProviderResources {
  /** Composites prepared and not yet destroyed. */
  composites: number;
  /** Composites attached and not yet destroyed. */
  attached: number;
  /** Shells started whose outcome has not been returned. */
  shells: number;
  /** Pane launches started whose outcome has not been returned. */
  launches: number;
}

/** A fresh, empty record. */
export function terminalProviderLog(): TerminalProviderLog {
  return {
    events: [],
    shown: new Map<number, string>(),
    live: { composites: 0, attached: 0, shells: 0, launches: 0 },
  };
}

/**
 * What a controlled composite does instead of opening a terminal.
 *
 * Each hook is a place a suite makes something happen or go wrong: `onPrepare`
 * refuses before a composite exists, `onAttach` fails the barrier, `shell`
 * decides what a self-closing pane's shell did and whether it started at all,
 * and `close` is the operation the grid waits on, so a suite controls exactly
 * when the reader leaves.
 */
export interface ControlledCompositeOptions {
  /** Appended to as the composite works, so ordering is read rather than timed. */
  readonly log?: TerminalProviderLog;
  onPrepare?: (request: TerminalGridRequest) => Operation<void>;
  onAttach?: () => Operation<void>;
  onDestroy?: () => Operation<void>;
  /**
   * Called as each pane state is displayed.
   *
   * A suite watches it to react to something the grid decided — a pane that
   * failed, a pane that became runnable — instead of waiting and hoping.
   */
  onUpdate?: (ordinal: number, state: TerminalPaneState) => void;
  shell?: (ordinal: number, spawned: () => void) => Operation<TerminalShellOutcome>;
  /**
   * What a pane launch does, in place of starting a native UI.
   *
   * Left out, a launch refuses — which is what a composite that cannot execute
   * one must do, and what keeps a suite that says nothing about launching from
   * quietly passing one to the root terminal.
   */
  launch?: (
    ordinal: number,
    request: NativeLaunchRequest,
    spawned: () => void,
  ) => Operation<NativeLaunchOutcome>;
  close?: () => Operation<void>;
}

/**
 * Prepare one composite that presents nothing and records everything.
 *
 * It answers the whole contract — attach, update, display, shell, close,
 * destroy — so a suite exercises core's lifecycle without a terminal, a
 * multiplexer, or a process anywhere in it.
 */
export function prepareControlledComposite(
  request: TerminalGridRequest,
  options: ControlledCompositeOptions = {},
  generation = 0,
): Operation<TerminalComposite> {
  return (function* (): Operation<TerminalComposite> {
    const log = options.log ?? terminalProviderLog();
    if (options.onPrepare) {
      yield* options.onPrepare(request);
    }
    log.events.push(`prepare:${generation}:${request.columns}x${request.rows}`);
    log.live.composites++;
    let destroyed = false;
    let attached = false;
    return {
      *attach() {
        if (options.onAttach) {
          yield* options.onAttach();
        }
        log.events.push(`attach:${generation}`);
        attached = true;
        log.live.attached++;
      },
      // deno-lint-ignore require-yield
      *update(ordinal, state) {
        log.events.push(`state:${generation}:${ordinal}:${state}`);
        options.onUpdate?.(ordinal, state);
      },
      // deno-lint-ignore require-yield
      *display(ordinal, text) {
        log.shown.set(ordinal, (log.shown.get(ordinal) ?? "") + text);
      },
      *shell(ordinal, spawned) {
        log.events.push(`shell:${generation}:${ordinal}`);
        log.live.shells++;
        try {
          if (options.shell) {
            return yield* options.shell(ordinal, spawned);
          }
          // The default shell starts: a suite that says nothing about a pane
          // wants a pane that works, and one that never reported a spawn would
          // hang the readiness barrier instead.
          spawned();
          return { exitCode: 0 };
        } finally {
          // Counted down however the shell left — returned, thrown, or
          // cancelled — because a shell a suite can still find is a shell the
          // provider is still holding.
          log.live.shells--;
        }
      },
      *launch(ordinal, request, spawned) {
        log.events.push(`launch:${generation}:${ordinal}`);
        if (options.launch === undefined) {
          throw new Error(`this composite cannot run a native launch in pane ${ordinal}`);
        }
        log.live.launches++;
        try {
          return yield* options.launch(ordinal, request, spawned);
        } finally {
          log.live.launches--;
        }
      },
      *closed() {
        if (options.close) {
          yield* options.close();
        }
        log.events.push(`closed:${generation}`);
      },
      *destroy() {
        // Destroying twice would make the record say a composite was taken down
        // more times than it was built, which is exactly the ordering claim a
        // suite reads this log for.
        if (destroyed) {
          throw new Error(`controlled composite ${generation} was destroyed twice`);
        }
        destroyed = true;
        if (options.onDestroy) {
          yield* options.onDestroy();
        }
        log.events.push(`destroy:${generation}`);
        log.live.composites--;
        if (attached) {
          attached = false;
          log.live.attached--;
        }
      },
    };
  })();
}

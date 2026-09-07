/**
 * The launcher a host installs when it has no terminal to give away.
 *
 * The other implementation of the contract in `./native-launcher.ts`, and the
 * one every suite that is not about a real terminal uses. It reaches no
 * process and no host stream — a launch here is whatever the row says it is —
 * and it lives in its own module so that importing the domain never loads a
 * fixture. Production code has no path to it: it is reachable only through
 * `@executablemd/terminal/test`.
 */

import { resource } from "effection";
import type { Operation } from "effection";
import { NativeLauncher } from "./native-launcher.ts";
import type { NativeLaunchOutcome, NativeLaunchRequest } from "./native-launcher.ts";

/**
 * How a controlled launch behaves.
 *
 * `record` sees each request in the order the provider made it; `outcome`
 * decides what the child did; and `wait` is the operation the launch blocks
 * on, so a test controls exactly how long the document stays suspended.
 */
export interface ControlledLauncherOptions {
  record?: (request: NativeLaunchRequest) => void;
  outcome?: (request: NativeLaunchRequest) => NativeLaunchOutcome;
  wait?: (request: NativeLaunchRequest) => Operation<void>;
  /**
   * Start the child, in place of a runtime that would.
   *
   * It receives the spawn report, so a test decides whether this launch starts
   * at all: reporting is what a successful start does, and throwing without
   * reporting is what a failure before the start does. Left out, the child
   * starts at once — a test that says nothing about starting wants a launch
   * that started.
   */
  start?: (request: NativeLaunchRequest, spawned: () => void) => Operation<void>;
  onReserve?: () => void;
  onFlush?: () => void;
  /** Each line the launch addressed to the terminal, in the order it said them. */
  onNotify?: (text: string) => void;
}

export function* installControlledLauncher(
  options: ControlledLauncherOptions = {},
): Operation<void> {
  let held = false;
  yield* NativeLauncher.around(
    {
      reserve() {
        return resource<void>(function* (provide) {
          if (held) {
            throw new Error(
              "another <Session.Launch> already holds this run's terminal — one " +
                "native UI owns the terminal at a time",
            );
          }
          held = true;
          options.onReserve?.();
          try {
            yield* provide();
          } finally {
            held = false;
          }
        });
      },
      // deno-lint-ignore require-yield
      *flush() {
        options.onFlush?.();
      },
      // deno-lint-ignore require-yield
      *notify([text]) {
        options.onNotify?.(text);
      },
      *launch([request, spawned]) {
        options.record?.(request);
        if (options.start) {
          yield* options.start(request, spawned);
        } else {
          spawned();
        }
        if (options.wait) {
          yield* options.wait(request);
        }
        return options.outcome?.(request) ?? { exitCode: 0 };
      },
    },
    { at: "min" },
  );
}

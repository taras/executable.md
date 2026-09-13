/**
 * A launcher a host installs when it has no terminal to give away, and no
 * intention of starting a native UI.
 *
 * `record` sees each request in the order the provider made it; `outcome`
 * decides what the child did; and `wait` is the operation the launch blocks
 * on, so a test controls exactly how long the document stays suspended.
 */

import { resource } from "effection";
import type { Operation } from "effection";

import { NativeLauncher } from "../mod.ts";
import type { NativeLaunchOutcome, NativeLaunchRequest } from "../mod.ts";

export interface ControlledLauncherOptions {
  record?: (request: NativeLaunchRequest) => void;
  outcome?: (request: NativeLaunchRequest) => NativeLaunchOutcome;
  wait?: (request: NativeLaunchRequest) => Operation<void>;
  onReserve?: () => void;
  onFlush?: () => void;
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
      *launch([request]) {
        options.record?.(request);
        if (options.wait) {
          yield* options.wait(request);
        }
        return options.outcome?.(request) ?? { exitCode: 0 };
      },
    },
    { at: "min" },
  );
}

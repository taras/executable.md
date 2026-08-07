import { ensure } from "effection";
import type { Operation } from "effection";
import { ProcessApi } from "@effectionx/process";
import { API } from "@executablemd/runtime";

/**
 * Records daemon lifetime against block execution at the process API
 * boundary, while the real work still happens: `daemon` delegates to the
 * real implementation, so a real subprocess spawns and is torn down.
 *
 * The ensure registers on the scope the daemon runs in — the invocation's
 * eval scope, the lifetime under test — before `next` acquires the daemon
 * resource, so LIFO fires `daemon:stop` only after the real process
 * teardown has completed. `probe` records when a `probe`-marked exec block
 * ran, which is how the timeline places invocation teardown relative to
 * the block after the component.
 */
export function* useDaemonTimeline(): Operation<string[]> {
  const timeline: string[] = [];
  yield* ProcessApi.around({
    *daemon([command, options], next) {
      timeline.push("daemon:start");
      yield* ensure(() => {
        timeline.push("daemon:stop");
      });
      return yield* next(command, options);
    },
  });
  yield* API.Process.around({
    *exec([options], next) {
      if (options.command.some((part) => part.includes("probe"))) {
        timeline.push("probe");
      }
      return yield* next(options);
    },
  });
  return timeline;
}

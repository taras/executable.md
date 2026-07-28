/**
 * A command adapter for suites that install `<TestAgent>` directly, standing
 * in for the runtime-named entrypoint that would otherwise supply one.
 *
 * It implements the same contract an entrypoint does: it receives the xmd
 * arguments and appends them to its own invocation, rather than returning a
 * prefix for the caller to extend.
 */
import { API } from "@executablemd/runtime";
import type { Operation } from "effection";

export function* useCommand(base: string[]): Operation<void> {
  yield* API.Env.around({
    *command([args = []], next) {
      void next; // terminal middleware — does not delegate
      return [...base, ...args];
    },
  });
}

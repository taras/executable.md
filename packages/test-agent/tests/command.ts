/**
 * Stands in for the runtime-named entrypoint that would otherwise install a
 * command adapter, so suites can drive `<TestAgent>` without starting a CLI.
 */
import { API } from "@executablemd/runtime";
import type { Operation } from "effection";

export function* useCommand(base: string[]): Operation<void> {
  yield* API.Env.around({
    *command([args = []]) {
      return [...base, ...args];
    },
  });
}

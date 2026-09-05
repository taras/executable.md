/**
 * Controlled surfaces that prove the neutral contract without a provider
 * (architecture.md §Package ownership).
 *
 * A launcher that hands out no terminal, a composite that presents nothing, and
 * a log whose counters are the evidence a lifecycle row reads. Production code
 * imports none of it; these exist so core lifecycle semantics can be proved
 * without tmux, a terminal, or a subprocess.
 *
 * The export is `./test`; the file is `testing.ts` because Deno's own test-file
 * pattern matches a bare `test.ts`, which would make the test runner load this
 * entrypoint as a test file in every shard.
 */

export { installControlledLauncher } from "./src/controlled-launcher.ts";
export type { ControlledLauncherOptions } from "./src/controlled-launcher.ts";
export { prepareControlledComposite, terminalProviderLog } from "./src/controlled-composite.ts";
export type {
  ControlledCompositeOptions,
  TerminalProviderLog,
  TerminalProviderResources,
} from "./src/controlled-composite.ts";

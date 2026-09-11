/**
 * How to run the stand-in tmux client, resolved from where the fixture lives.
 *
 * The fixture belongs to this package, so the path is derived from this
 * module's own URL rather than written relative to a repository root. A suite
 * in another package drives the same client without knowing where it sits, and
 * moving the fixture again cannot leave behind a stale string that starts no
 * process — a failure that reads as "nothing was signalled" rather than as a
 * missing file, and one that a row expecting a client to stay put can pass
 * without noticing.
 */

import { fileURLToPath } from "node:url";
import { cliCommand } from "@executablemd/test-support/launch";

export function clientCommand(mode: "control" | "attach", script: string): readonly string[] {
  const fixture = fileURLToPath(new URL("./tmux-client.ts", import.meta.url));
  const invocation = cliCommand([]);
  // The same runtime the CLI runs under, pointed at the fixture instead.
  return [invocation.command, "run", "--allow-all", fixture, mode, script];
}

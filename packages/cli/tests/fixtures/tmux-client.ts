/**
 * A stand-in for one tmux client, so a grid's lifecycle can be exercised
 * without tmux.
 *
 * Two modes, because the composite keeps two clients apart and a test that
 * conflated them would prove nothing about the distinction:
 *
 * - `control` writes lines to stdout as they appear in the script file, and
 *   ends at `%exit`. The composite reads it through the same line splitting and
 *   the same classifier it uses on real control mode, so what is faked is the
 *   server, never the parsing.
 * - `attach` holds the terminal, and leaves when the script file says it was
 *   detached. It writes nothing.
 *
 * The script file is how a test says what the server did. Appending to it is
 * the fake server's way of speaking, and polling it is this program's; neither
 * is a claim about how tmux does it.
 *
 * Terminal restoration is deliberately outside this: a process that inherits a
 * pipe cannot restore a terminal it never had. That a real `tmux attach` gives
 * the terminal back when asked to detach is #726's evidence, on real tmux.
 */

import process from "node:process";
import { exists, readTextFile } from "@effectionx/fs";
import { run, sleep, withResolvers } from "effection";
import type { Operation } from "effection";

const POLL_MS = 15;

type Mode = "control" | "attach";

/** Everything the script says so far, or nothing while it does not exist. */
function* said(script: string): Operation<string[]> {
  if (!(yield* exists(script))) {
    return [];
  }
  const text = yield* readTextFile(script);
  return text.split("\n").filter((line) => line.length > 0);
}

function write(text: string): Operation<void> {
  const written = withResolvers<void>();
  process.stdout.write(text, () => written.resolve());
  return written.operation;
}

/** Follow the script until it says this client is finished. */
export function* followScript(mode: Mode, script: string): Operation<void> {
  let seen = 0;
  while (true) {
    const lines = yield* said(script);
    for (const line of lines.slice(seen)) {
      if (mode === "control") {
        yield* write(`${line}\n`);
        if (line.startsWith("%exit")) {
          return;
        }
      } else if (line === "detached") {
        // The reader left. A real client would restore the terminal here.
        return;
      }
    }
    seen = lines.length;
    yield* sleep(POLL_MS);
  }
}

const [mode, script] = process.argv.slice(2);
if ((mode !== "control" && mode !== "attach") || script === undefined) {
  process.stderr.write("usage: tmux-client.ts <control|attach> <script-file>\n");
  process.exit(2);
}
await run(() => followScript(mode, script));

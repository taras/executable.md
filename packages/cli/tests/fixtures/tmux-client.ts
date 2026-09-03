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

import { readFile } from "node:fs/promises";
import process from "node:process";

const POLL_MS = 15;

const [mode, script] = process.argv.slice(2);
if ((mode !== "control" && mode !== "attach") || script === undefined) {
  process.stderr.write("usage: tmux-client.ts <control|attach> <script-file>\n");
  process.exit(2);
}

/** Everything the script says so far, or nothing while it does not exist. */
async function read(): Promise<string[]> {
  try {
    const text = await readFile(script, "utf8");
    return text.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

let seen = 0;
for (;;) {
  const said = await read();
  for (const line of said.slice(seen)) {
    if (mode === "control") {
      process.stdout.write(`${line}\n`);
      if (line.startsWith("%exit")) {
        process.exit(0);
      }
    } else if (line === "detached") {
      // The reader left. A real client would restore the terminal here.
      process.exit(0);
    }
  }
  seen = said.length;
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

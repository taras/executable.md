/**
 * The REPL's host on Bun.
 *
 * Named for its runtime because every answer here is one only the running
 * process can give: the platform and home directory it is standing on, a random
 * identifier, and the two filesystem operations `@effectionx/fs` does not offer.
 * Nothing registers it — `bun.ts` installs it when `xmd repl` is the command
 * that was selected.
 */

import { randomBytes } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import process from "node:process";
import type { Operation } from "effection";
import { installReplHost, platformDataRoot } from "./repl-assembly.ts";
import { useBunReplTerminal } from "./bun-repl-terminal.ts";

/** Install everything the REPL needs from this host. */
export function* useBunRepl(): Operation<void> {
  yield* installReplHost({
    dataRoot: () => platformDataRoot(process.platform, homedir(), process.env, sep),
    // Sixteen random bytes as hex: URL-safe, opaque, and not derived from a
    // path, a clock or a counter, none of which a location should leak.
    identify: () => randomBytes(16).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  yield* useBunReplTerminal();
}

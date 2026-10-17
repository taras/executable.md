/**
 * The REPL's host inside the compiled binary.
 *
 * Named for its runtime because every answer here is one only the running
 * process can give: the platform and home directory it is standing on, a random
 * identifier, and the two filesystem operations `@effectionx/fs` does not offer.
 * Nothing registers it — `compiled.ts` installs it when `xmd repl` is the command
 * that was selected.
 */

import { randomBytes } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import process from "node:process";
import type { Operation } from "effection";
import { installReplHost, platformDataRoot, replHostFacts } from "./repl-assembly.ts";
import { XMD_VERSION } from "./cli.ts";
import { useCompiledReplTerminal } from "./compiled-repl-terminal.ts";

export function* useCompiledRepl(): Operation<void> {
  yield* installReplHost({
    dataRoot: () => platformDataRoot(process.platform, homedir(), process.env, sep),
    // What this process is, stated here because this is where it is known.
    // A reply reads these as the host's own facts; nothing downstream sniffs
    // for a runtime global to work them out again.
    environment: () =>
      replHostFacts({
        runtime: `a compiled binary built with deno ${process.versions.deno ?? "unknown"}`,
        version: XMD_VERSION,
        platform: process.platform,
        architecture: process.arch,
      }),
    // Sixteen random bytes as hex: URL-safe, opaque, and not derived from a
    // path, a clock or a counter, none of which a location should leak.
    identify: () => randomBytes(16).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  yield* useCompiledReplTerminal();
}

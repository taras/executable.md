import { useNodeReplProjectAccess } from "./node-repl-project-access.ts";
import { useNodeReplAssetImport } from "./node-repl-asset-import.ts";
/**
 * The REPL's host inside the compiled binary.
 *
 * Named for its runtime because every answer here is one only the running
 * process can give: the platform and home directory it is standing on, a random
 * identifier, and the two filesystem operations `@effectionx/fs` does not offer.
 * Nothing registers it — `compiled.ts` installs it when `xmd repl` is the command
 * that was selected.
 */

import { installTodoSource } from "./node-todo-source.ts";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { stat } from "@effectionx/fs";
import { access, appendFile, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import process from "node:process";
import { until, type Operation } from "effection";
import { installReplHost, platformDataRoot, replHostFacts } from "./repl-assembly.ts";
import { XMD_VERSION } from "./cli.ts";
import { useCompiledReplTerminal } from "./compiled-repl-terminal.ts";

function* canUseBareXmd(): Operation<boolean> {
  if (process.argv0 !== "xmd") {
    return false;
  }
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    // Relative search entries can select another file when the command is pasted elsewhere.
    if (!isAbsolute(directory)) {
      return false;
    }
    const candidate = join(directory, "xmd");
    try {
      if (!(yield* stat(candidate)).isFile) {
        continue;
      }
      yield* until(access(candidate, constants.X_OK));
    } catch {
      continue;
    }
    try {
      return (yield* until(realpath(candidate))) === (yield* until(realpath(process.execPath)));
    } catch {
      return false;
    }
  }
  return false;
}

export function* useCompiledRepl(command: readonly string[], interactive = true): Operation<void> {
  yield* useNodeReplAssetImport();
  yield* useNodeReplProjectAccess();
  yield* installTodoSource();
  const reopen = { command: interactive && (yield* canUseBareXmd()) ? ["xmd"] : command };
  yield* installReplHost({
    reopen,
    dataRoot: () => platformDataRoot(process.platform, homedir(), process.env, sep),
    // What this process is, stated here because this is where it is known.
    // A reply reads these as the host's own facts; nothing downstream sniffs
    // for a runtime global to work them out again.
    environment: () =>
      replHostFacts({
        runtime: `a compiled binary built with deno ${process.versions.deno ?? "unknown"}`,
        version: XMD_VERSION,
        launch: { command },
        binary: process.execPath,
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

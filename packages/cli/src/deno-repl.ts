import { useNodeReplProjectAccess } from "./node-repl-project-access.ts";
import { useNodeReplAssetImport } from "./node-repl-asset-import.ts";
/**
 * The REPL's host on Deno.
 *
 * Named for its runtime because every answer here is one only the running
 * process can give: the platform and home directory it is standing on, a random
 * identifier, and the two filesystem operations `@effectionx/fs` does not offer.
 * Nothing registers it — `deno.ts` installs it when `xmd repl` is the command
 * that was selected.
 */

import { installTodoSource } from "./node-todo-source.ts";
import { randomBytes } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import process from "node:process";
import type { Operation } from "effection";
import { installReplHost, platformDataRoot, replHostFacts } from "./repl-assembly.ts";
import { readSourceCheckout } from "./node-repl-build.ts";
import { XMD_VERSION } from "./cli.ts";
import { useDenoReplTerminal } from "./deno-repl-terminal.ts";

export function* useDenoRepl(entrypoint?: string, launcher?: string): Operation<void> {
  yield* useNodeReplAssetImport();
  yield* useNodeReplProjectAccess();
  yield* installTodoSource();
  const checkout = entrypoint === undefined ? undefined : yield* readSourceCheckout(entrypoint);
  const launch =
    launcher === undefined || entrypoint === undefined
      ? undefined
      : {
          command: [process.execPath, "run", "--allow-all", entrypoint],
          ...(launcher === "repository-task"
            ? { assignments: { XMD_REPL_DENO_PROFILE: "repository-task" } }
            : {}),
        };
  const reopen =
    launch === undefined || launcher === undefined || entrypoint === undefined
      ? null
      : launcher === "repository-task"
        ? { ...launch, directory: process.cwd() }
        : {
            command: [launcher],
            assignments: {
              XMD_DEV_ROOT: resolve(entrypoint, "../../../.."),
              XMD_DEV_DENO: process.execPath,
            },
          };
  yield* installReplHost({
    reopen,
    dataRoot: () => platformDataRoot(process.platform, homedir(), process.env, sep),
    // What this process is, stated here because this is where it is known.
    // A reply reads these as the host's own facts; nothing downstream sniffs
    // for a runtime global to work them out again.
    environment: () =>
      replHostFacts({
        runtime: `deno ${process.versions.deno ?? "unknown"} from source`,
        version: XMD_VERSION,
        launch,
        checkout,
        platform: process.platform,
        architecture: process.arch,
      }),
    // Sixteen random bytes as hex: URL-safe, opaque, and not derived from a
    // path, a clock or a counter, none of which a location should leak.
    identify: () => randomBytes(16).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  yield* useDenoReplTerminal();
}

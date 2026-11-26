import { useNodeReplProjectAccess } from "./node-repl-project-access.ts";
import { useNodeReplAssetImport } from "./node-repl-asset-import.ts";
/**
 * The REPL's host on Node.
 *
 * Named for its runtime because every answer here is one only the running
 * process can give: the platform and home directory it is standing on, a random
 * identifier, and the two filesystem operations `@effectionx/fs` does not offer.
 * Nothing registers it — `node.ts` installs it when `xmd repl` is the command
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
import { readSourceCheckout, requiredRuntimeDirectory } from "./node-repl-build.ts";
import { XMD_VERSION } from "./cli.ts";
import { useNodeReplTerminal } from "./node-repl-terminal.ts";

function inheritedNodeOptions(value: string): string[] {
  // NODE_OPTIONS splits on spaces outside double quotes and escapes only inside them.
  return Array.from(value.matchAll(/(?:[^ "]+|"(?:[^"\\]|\\[\s\S])*")+/g), ([word]) =>
    word.replace(/"((?:[^"\\]|\\[\s\S])*)"/g, (_quote, quoted: string) =>
      quoted.replace(/\\([\s\S])/g, "$1"),
    ),
  );
}

export function* useNodeRepl(command: readonly string[], interactive = true): Operation<void> {
  yield* useNodeReplAssetImport();
  yield* useNodeReplProjectAccess();
  yield* installTodoSource();
  const checkout = interactive ? yield* readSourceCheckout(command.at(-1)) : undefined;
  const config = process.env["TSX_TSCONFIG_PATH"];
  const directory = requiredRuntimeDirectory(
    [...command.slice(1, -1), ...inheritedNodeOptions(process.env["NODE_OPTIONS"] ?? "")],
    process.cwd(),
  );
  const reopen = {
    command,
    directory,
    ...(config === undefined ? {} : { assignments: { TSX_TSCONFIG_PATH: resolve(config) } }),
  };
  yield* installReplHost({
    reopen,
    dataRoot: () => platformDataRoot(process.platform, homedir(), process.env, sep),
    // What this process is, stated here because this is where it is known.
    // A reply reads these as the host's own facts; nothing downstream sniffs
    // for a runtime global to work them out again.
    environment: () =>
      replHostFacts({
        runtime: `node ${process.versions.node}`,
        version: XMD_VERSION,
        launch: reopen,
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
  yield* useNodeReplTerminal();
}

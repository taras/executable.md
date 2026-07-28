/**
 * Launch the xmd CLI under whichever runtime is running the tests.
 *
 * Detecting the runtime here is what this package is for: it is the
 * host-adapter boundary for tests (AGENTS.md rule 12).
 */

import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Suites run the CLI from temp directories, so paths cannot come from cwd.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function entry(runtime: string): string {
  return join(ROOT, "packages", "cli", "src", `${runtime}.ts`);
}

export function cliBase(): string[] {
  if (Reflect.has(globalThis, "Deno")) {
    return [process.execPath, "run", "--allow-all", entry("deno")];
  }
  if (Reflect.has(globalThis, "Bun")) {
    return [process.execPath, entry("bun")];
  }
  // A fresh tsx process rather than the running one: a CLI subprocess must not
  // inherit --test or the runner's loaders from process.execArgv.
  return ["tsx", "--tsconfig", join(ROOT, "tsconfig.node.json"), entry("node")];
}

export function cliCommand(args: string[]): { command: string; arguments: string[] } {
  const [command, ...prefix] = cliBase();
  return { command, arguments: [...prefix, ...args] };
}

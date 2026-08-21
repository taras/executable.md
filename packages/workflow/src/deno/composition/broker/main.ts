/**
 * The unadvertised internal modes, and how this host starts one.
 *
 * Two of them: the broker a provider invocation runs, and the shim Git runs.
 * Neither is a command a person invokes. They appear in no help and in no public
 * grammar, they take no argument a document can influence, and neither can
 * acquire anything by itself — the broker is useless without a locator this
 * process minted a lease for, and the shim is useless without an endpoint and a
 * capability it cannot guess.
 */

import process from "node:process";
import { fileURLToPath } from "node:url";
import { serveCredentialBroker } from "./child.ts";
import { serveCredentialShim } from "./shim.ts";
import type { InternalExecution, InternalModes } from "./host.ts";

/** The argument that selects an internal mode, and the two modes. */
export const INTERNAL_MODE = "__xmd-credential";
export const BROKER_MODE = "broker";
export const SHIM_MODE = "shim";

/**
 * Run an internal mode when these arguments select one, and say whether it did.
 *
 * The entrypoint calls this before it parses anything else. A caller who did not
 * select a mode gets `false` and the ordinary command line, which is why this
 * mode is invisible: nothing about it changes what any other invocation does.
 */
export function runInternalMode(argv: readonly string[]): boolean {
  if (argv[0] !== INTERNAL_MODE) {
    return false;
  }
  const mode = argv[1];
  const rest = argv.slice(2);
  if (mode === BROKER_MODE) {
    serveCredentialBroker();
    return true;
  }
  if (mode === SHIM_MODE) {
    // The shim is the one mode that answers on standard output, and it is the
    // one thing this process does.
    void serveCredentialShim(rest);
    return true;
  }
  process.exit(2);
}

/**
 * How to start this host's internal modes.
 *
 * Two shapes, and which one applies is decided by what is executing. A compiled
 * binary *is* the host, so it starts its own modes; running from source, the
 * executable is Deno and the module has to be named to it. Nothing here reads
 * the filesystem to find out — the executable's own identity is the answer.
 */
export function internalModes(
  execPath: string = process.execPath,
  moduleUrl: string = import.meta.url,
): InternalModes {
  const name = execPath.replace(/\\.exe$/, "");
  const compiled = !(name.endsWith("/deno") || name.endsWith("\\\\deno") || name === "deno");
  const mode = (which: string): InternalExecution =>
    compiled
      ? { command: execPath, args: [INTERNAL_MODE, which] }
      : {
          command: execPath,
          args: ["run", "--allow-all", fileURLToPath(moduleUrl), INTERNAL_MODE, which],
        };
  return {
    broker: () => mode(BROKER_MODE),
    shim: () => mode(SHIM_MODE),
  };
}

// Running from source, this module is the program the modes are started through.
if (import.meta.main) {
  runInternalMode(process.argv.slice(2));
}

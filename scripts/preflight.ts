/**
 * Refuse to build an unprepared worktree, and say what to run.
 *
 * Usage (through the tasks, never directly):
 *   deno run --allow-all --node-modules-dir=none --cached-only --frozen \
 *     scripts/preflight.ts <script> [args...]
 *
 * A build phase runs `--cached-only`, so a cold cache stops Deno before the
 * build's own first statement — measured, on a scratch `DENO_DIR`:
 *
 *     error: JSR package manifest for '@std/encoding' failed to load.
 *     Specifier not found in cache ..., --cached-only is specified.
 *
 * An assertion inside the build is therefore unreachable exactly when it is
 * needed. This file runs instead, and it can, because it imports nothing but a
 * relative source file: no npm, no JSR, no https, nothing a cold cache lacks.
 * Effection is a dependency like any other, so this file works with the host
 * directly and stays synchronous throughout — `outputSync` runs the build with
 * inherited stdio and hands back its status without a promise.
 *
 * It checks what preparation recorded, not what a build happens to need, so the
 * diagnostic is the same whichever half is missing.
 */

import { PREPARED_INPUTS, PREPARED_MARKER, recordedCopy } from "./lib/prepared.ts";

const repoRoot = new URL("../", import.meta.url);

const SETUP = "deno task setup";

function read(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(new URL(path, repoRoot));
  } catch {
    return undefined;
  }
}

function unprepared(): string | undefined {
  for (const input of PREPARED_INPUTS) {
    const recorded = read(recordedCopy(input));
    if (recorded === undefined) {
      return `${PREPARED_MARKER} has no record of ${input}`;
    }
    const current = read(input);
    if (current === undefined) {
      return `${input} is missing`;
    }
    if (current !== recorded) {
      return `${input} changed since dependencies were installed`;
    }
  }
  return undefined;
}

const [script, ...args] = Deno.args;
if (!script) {
  console.error("usage: preflight.ts <script> [args...]");
  Deno.exit(1);
}

const missing = unprepared();
if (missing) {
  console.error(`${missing} — run \`${SETUP}\``);
  Deno.exit(1);
}

const build = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-all",
    "--node-modules-dir=none",
    "--cached-only",
    "--frozen",
    script,
    ...args,
  ],
  cwd: new URL(repoRoot).pathname,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).outputSync();

Deno.exit(build.code);

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
 * needed. This file runs instead, and it can, because it imports only local
 * source and built-ins: no npm, no JSR, no https, nothing a cold cache lacks.
 * Effection is a dependency like any other, so this file works with the host
 * directly and stays synchronous throughout — `outputSync` runs the build with
 * inherited stdio and hands back its status without a promise.
 *
 * It checks what preparation recorded, not what a build happens to need, so the
 * diagnostic is the same whichever half is missing.
 */

import { unprepared } from "./lib/preflight-deno.ts";

const repoRoot = new URL("../", import.meta.url);
const SETUP = "deno task setup";

const [script, ...args] = Deno.args;
if (!script) {
  console.error("usage: preflight.ts <script> [args...]");
  Deno.exit(1);
}

const missing = unprepared(repoRoot);
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

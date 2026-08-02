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
 *
 * It checks what preparation records, not what a build happens to need, so the
 * diagnostic is the same whichever half is missing. When the record is current
 * it spawns the real command with the inherited stdio and exits with its
 * status, adding nothing to the output.
 *
 * Effection is a dependency, so this one file cannot use it (AGENTS.md code
 * rule 1) and reads synchronously, with a single top-level `await` for the
 * child's exit status.
 */

import { isCurrent, digest, PREPARED_INPUTS, PREPARED_MARKER } from "./lib/prepared.ts";

const repoRoot = new URL("../", import.meta.url);

const SETUP = "deno task setup";

function read(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(new URL(path, repoRoot));
  } catch {
    return undefined;
  }
}

function prepared(): string | undefined {
  const marker = read(PREPARED_MARKER);
  if (marker === undefined) {
    return `${PREPARED_MARKER} is missing`;
  }

  const encoder = new TextEncoder();
  const inputs: string[] = [];
  for (const path of PREPARED_INPUTS) {
    const contents = read(path);
    if (contents === undefined) {
      return `${path} is missing`;
    }
    inputs.push(digest(encoder.encode(contents)));
  }

  let recorded: unknown;
  try {
    recorded = JSON.parse(marker);
  } catch {
    return `${PREPARED_MARKER} is not readable`;
  }
  if (!isCurrent(recorded, inputs)) {
    return `${PREPARED_INPUTS.join(" or ")} changed since dependencies were installed`;
  }
  return undefined;
}

const [script, ...args] = Deno.args;
if (!script) {
  console.error("usage: preflight.ts <script> [args...]");
  Deno.exit(1);
}

const unprepared = prepared();
if (unprepared) {
  console.error(`${unprepared} — run \`${SETUP}\``);
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
}).spawn();

Deno.exit((await build.status).code);

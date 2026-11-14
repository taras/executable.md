import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { gitRoot, resolveGitRevision } from "@executablemd/git/api";
import { API } from "@executablemd/runtime";
import { scoped, until } from "effection";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Launch, Size } from "./protocol.ts";
import { z } from "zod";
import { worktree } from "./protocol.ts";

export const root = dirname(fileURLToPath(new URL("deno.json", worktree)));
export const evidence = join(root, ".bench");

const cachedDenoFlags = ["--cached-only", "--frozen", "--node-modules-dir=none"];
const cliEntry = "packages/cli/src/deno.ts";

export function denoCommand(args: string[], checkout = root): string[] {
  return [
    "deno",
    "run",
    "--allow-all",
    ...cachedDenoFlags,
    "--config",
    join(checkout, "deno.json"),
    join(checkout, cliEntry),
    ...args,
  ];
}

function* readWorktree(checkout: string) {
  return yield* scoped(function* () {
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *cwd() {
        return checkout;
      },
    });
    const topLevel = yield* gitRoot();
    const revision = yield* resolveGitRevision("HEAD");
    yield* Stdio.around(
      {
        // deno-lint-ignore require-yield
        *stdout() {
          return;
        },
      },
      { at: "min" },
    );
    const status = (yield* exec("git", {
      cwd: checkout,
      arguments: ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    }).expect()).stdout;
    return { topLevel, revision, dirty: status.trim() !== "" };
  });
}

export interface PreparedBuild {
  readonly checkout: string;
  readonly expectedRevision?: string;
}

function* checkoutState(checkout: string, expectedRevision?: string) {
  const actual = yield* readWorktree(checkout);
  if ((yield* until(realpath(actual.topLevel))) !== checkout) {
    throw new Error(`XMD.Build needs the root of a worktree: ${checkout}`);
  }
  if (expectedRevision !== undefined && (actual.revision !== expectedRevision || actual.dirty)) {
    throw new Error(`XMD.Build needs a clean worktree at ${expectedRevision}: ${checkout}`);
  }
  if (!(yield* exists(join(checkout, "node_modules", ".xmd-prepared", "deno.lock")))) {
    throw new Error(`Run deno task setup in the XMD.Build worktree: ${checkout}`);
  }
  return actual;
}

export function* assertPinnedWorktree(checkout: string, expectedRevision: string) {
  yield* checkoutState(checkout, expectedRevision);
}

function* denoCache(executable: string, checkout: string) {
  return yield* scoped(function* () {
    yield* Stdio.around(
      {
        // deno-lint-ignore require-yield
        *stdout() {
          return;
        },
      },
      { at: "min" },
    );
    const info = (yield* exec(executable, {
      cwd: checkout,
      arguments: ["info", "--json"],
    }).expect()).stdout;
    return z.object({ denoDir: z.string() }).parse(JSON.parse(info)).denoDir;
  });
}

export function* prepareRun(
  cwd: string,
  size: Size,
  args: string[],
  options?: { home?: string; scenario?: string; build?: PreparedBuild; command?: string[] },
) {
  const checkout =
    options?.build === undefined
      ? options?.command === undefined
        ? root
        : undefined
      : yield* until(realpath(options.build.checkout));
  const actual =
    checkout === undefined
      ? undefined
      : yield* checkoutState(checkout, options?.build?.expectedRevision);
  const id = randomUUID();
  const directory = join(evidence, id);
  yield* ensureDir(directory);
  let command = options?.command ?? denoCommand(["repl", ...args], checkout);
  const [executable, verb, permissions] = command;
  const isDenoSource = executable !== undefined && verb === "run" && permissions === "--allow-all";
  const denoDir = isDenoSource ? yield* denoCache(executable, checkout ?? root) : undefined;
  if (options?.command !== undefined && isDenoSource) {
    // Preserve the source host's cache across the private home and forbid installs.
    command = [executable, verb, permissions, ...cachedDenoFlags, ...command.slice(3)];
  }
  const revision = actual?.revision ?? null;
  const launch: Launch = {
    ...size,
    ...(checkout === undefined ? {} : { entry: join(checkout, cliEntry), worktree: checkout }),
    command,
    denoDir,
    directory,
    cwd,
    home: options?.home ?? join(directory, "home"),
    scenario: options?.scenario,
    args,
  };
  yield* writeTextFile(
    join(directory, "run.json"),
    JSON.stringify({ id, revision, dirty: actual?.dirty ?? null, ...launch }, null, 2),
  );
  return { id, revision, launch };
}

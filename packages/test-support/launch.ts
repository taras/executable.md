import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import type { Operation } from "effection";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Suites run the CLI from temp directories, so paths cannot come from cwd.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function entry(runtime: string): string {
  return join(ROOT, "packages", "cli", "src", `${runtime}.ts`);
}

/**
 * Which entrypoint `runCli` launches.
 *
 * Runtime detection belongs to this package and nowhere else (Code Rule 12), so
 * a suite whose subject differs by host — `xmd workflow`, which only the Deno
 * entrypoints support — asks here rather than reading a global of its own.
 */
export function cliRuntime(): "deno" | "bun" | "node" {
  if (Reflect.has(globalThis, "Deno")) {
    return "deno";
  }
  return Reflect.has(globalThis, "Bun") ? "bun" : "node";
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

/**
 * What a subprocess needs from this one: where to find executables, and where
 * each runtime caches what it downloads. `HOME` is deliberately absent — a run
 * that exercises user configuration supplies an isolated one — so a
 * developer's own configuration cannot reach a test.
 */
const INHERITED = ["PATH", "DENO_DIR", "DENO_INSTALL_ROOT", "XDG_CACHE_HOME", "TMPDIR"];

const DEFAULT_TIMEOUT = 60_000;

export interface CliRunOptions {
  /** Working directory for the run. Defaults to this process's. */
  cwd?: string;
  /** Variables set on top of the inherited ones. */
  env?: Record<string, string>;
  /** Inherit the whole environment rather than the names a run needs. */
  inheritEnv?: boolean;
  /** Milliseconds before the run is abandoned (default 60s). */
  timeout?: number;
}

/** A bounded run of `xmd`, synchronized like any `@effectionx/process` exec. */
export interface CliRun {
  /** Wait for completion and return the exit status with captured output. */
  join(): Operation<ProcessResult>;
  /** Like `join()`, but a nonzero exit raises. */
  expect(): Operation<ProcessResult>;
}

/**
 * Run `xmd` under the host runtime.
 *
 * Suites shell out so exit status and diagnostics are observed the way a
 * caller sees them, TTY-independently. Capture belongs to `@effectionx/process`
 * — a suite never reads the streams itself — and command, cwd, environment, and
 * timeout are configured here so every suite launches the same way.
 */
export function runCli(args: string[], options: CliRunOptions = {}): CliRun {
  return {
    join: () => bounded(args, options, (run) => run.join()),
    expect: () => bounded(args, options, (run) => run.expect()),
  };
}

function* bounded(
  args: string[],
  options: CliRunOptions,
  settle: (run: ReturnType<typeof exec>) => Operation<ProcessResult>,
): Operation<ProcessResult> {
  const limit = options.timeout ?? DEFAULT_TIMEOUT;
  const result = yield* timebox<ProcessResult>(limit, function* () {
    const cli = cliCommand(args);
    return yield* settle(
      exec(cli.command, {
        arguments: cli.arguments,
        cwd: options.cwd,
        env: cliEnv(options),
      }),
    );
  });
  if (result.timeout) {
    throw new Error(`xmd ${args.join(" ")} timed out after ${limit}ms`);
  }
  return result.value;
}

function cliEnv(options: CliRunOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const names = options.inheritEnv ? Object.keys(process.env) : INHERITED;
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return { ...env, ...options.env };
}

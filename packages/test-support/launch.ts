import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { Err, Ok, ensure, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { loadavg } from "node:os";
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
 * The same command as one quoted shell word list.
 *
 * A suite whose subject is what a *pipeline* delivers — a regular-file
 * redirect, a reader that closes early — needs the CLI as text it can compose
 * around, and the runtime it belongs to is still this package's to know.
 */
export function cliShellCommand(args: string[]): string {
  const cli = cliCommand(args);
  return [cli.command, ...cli.arguments].map(shellQuote).join(" ");
}

/** One shell word, quoted — a path a composed line names goes through here too. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
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
  /**
   * Exactly this text on the child's standard input, followed by end of file.
   *
   * Omitting it leaves the child's stdin as the launcher has always left it. An
   * empty string is a value like any other: the child observes an immediate end
   * of file rather than nothing at all.
   */
  stdin?: string;
  /**
   * Handed the child this launcher owns, before anything is attached to it,
   * together with a reader for what has been captured from it so far.
   *
   * Package-private, for the cancellation regression: the listeners are on a
   * value this operation owns and does not otherwise hand out, and what a
   * cancelled run must prove is that they are gone *and* that a later chunk
   * reaches nothing that is still accumulating.
   */
  observeChild?: (child: ChildProcess, captured: () => { stdout: string; stderr: string }) => void;
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
  const launch = cliCommand(args);
  const label = `xmd ${args.join(" ")}`;
  return {
    join: () => bounded(launch, label, options, "join"),
    expect: () => bounded(launch, label, options, "expect"),
  };
}

/**
 * Run a shell line the caller composed, in the environment `runCli` uses.
 *
 * Compose it from `cliShellCommand()`. The exit status reported is the shell's,
 * which in a pipeline is the last stage's — a row that needs the CLI's own
 * status reports it out of band.
 */
export function runShell(line: string, options: CliRunOptions = {}): CliRun {
  const launch = { command: line, shell: true };
  return {
    join: () => bounded(launch, line, options, "join"),
    expect: () => bounded(launch, line, options, "expect"),
  };
}

/** Everything the child wrote on one channel before its run settled. */
interface PartialOutput {
  stdout: string;
  stderr: string;
}

interface Launch {
  command: string;
  arguments?: string[];
  shell?: boolean;
}

function* bounded(
  launch: Launch,
  label: string,
  options: CliRunOptions,
  mode: "join" | "expect",
): Operation<ProcessResult> {
  const limit = options.timeout ?? DEFAULT_TIMEOUT;
  // Accumulated outside the deadline, so a run the deadline abandons still has
  // an account: a timeout that reports nothing but its duration cannot say
  // whether the child hung before its first line or after its last.
  const partial: PartialOutput = { stdout: "", stderr: "" };
  const result = yield* timebox<ProcessResult>(limit, function* () {
    const input = options.stdin;
    if (input !== undefined) {
      return yield* withInput(launch, options, partial, mode, input);
    }
    const child = yield* exec(launch.command, {
      arguments: launch.arguments,
      shell: launch.shell,
      cwd: options.cwd,
      env: cliEnv(options),
    });
    yield* spawn(function* () {
      const output = yield* child.stdout;
      for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
        partial.stdout += text(next.value);
      }
    });
    yield* spawn(function* () {
      const output = yield* child.stderr;
      for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
        partial.stderr += text(next.value);
      }
    });
    const status = yield* mode === "expect" ? child.expect() : child.join();
    return { ...status, stdout: partial.stdout, stderr: partial.stderr };
  });
  if (result.timeout) {
    throw new Error(abandonedReport(label, limit, partial));
  }
  return result.value;
}

// Chunks decode independently, exactly as capture concatenates them.
function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** How long a terminated child is given to close before the signal escalates. */
const TERMINATION_GRACE = 2_000;

/**
 * The same bounded run, for a child that has to observe a real end of file.
 *
 * `@effectionx/process` publishes stdin as a writable that can send and never
 * close, so a CLI reading to end of file would wait forever behind it. This
 * path owns the child instead, writes the supplied text and closes the pipe, so
 * what the CLI observes is the pipeline a caller would build. Everything else
 * is the launcher's: the same environment, the same capture into the caller's
 * accumulators, and the same status handling.
 *
 * Owning the child means owning its exit. Teardown is registered before this
 * operation can suspend, and it finishes only once the child's own `close`
 * boundary has been reached — a signal that has been sent is not a process that
 * is gone. A group that has not closed within the grace period is escalated to
 * `SIGKILL`, so a child ignoring `SIGTERM` cannot outlive the run that started
 * it or hold the deadline open.
 */
function* withInput(
  launch: Launch,
  options: CliRunOptions,
  partial: PartialOutput,
  mode: "join" | "expect",
  input: string,
): Operation<ProcessResult> {
  const settled = withResolvers<Result<{ code?: number; signal?: string }>>();
  // `close`, and nothing else, is what says this child and its pipes are done.
  let closed = false;
  // Declared before the cleanup below and assigned after it: a child that
  // exists before its release is registered can be stranded, because `yield*
  // ensure(...)` is itself a suspension and an owner halted while it registers
  // unwinds with nothing on it.
  let child: ChildProcess | undefined;

  const onStdout = (chunk: Uint8Array): void => {
    partial.stdout += text(chunk);
  };
  const onStderr = (chunk: Uint8Array): void => {
    partial.stderr += text(chunk);
  };
  // A child that never started closes through this rather than through `close`,
  // so teardown has an end either way.
  const onError = (error: Error): void => {
    settled.resolve(Err(error));
  };
  // A pipe the child could not use is the launcher's problem and not the run's:
  // the close below is what this whole path exists for, and a broken one would
  // otherwise raise on a process that is already reporting why.
  const onStdinError = (): void => {};
  const onClose = (code: number | null, signal: string | null): void => {
    closed = true;
    settled.resolve(
      Ok({
        ...(code === null ? {} : { code }),
        ...(signal === null ? {} : { signal }),
      }),
    );
  };

  // Established before the child exists, so a run cancelled anywhere below
  // still ends with its process group gone — and so that no instant exists in
  // which a child is running with no cleanup registered for it.
  //
  // Teardown keeps every handler attached through the reap: `close` is what
  // says the process is finished, and the capture must still be reading what
  // the child writes on its way out. They come off synchronously once that
  // wait has settled, whichever way it did.
  yield* ensure(function* () {
    if (child === undefined) {
      return;
    }

    try {
      yield* reap(child, () => closed);
    } finally {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.stdin?.off("error", onStdinError);
      child.off("close", onClose);
    }
  });

  child = spawnChild(launch.command, launch.arguments ?? [], {
    detached: true,
    shell: launch.shell,
    cwd: options.cwd,
    env: cliEnv(options),
    stdio: "pipe",
  });

  options.observeChild?.(child, () => ({ stdout: partial.stdout, stderr: partial.stderr }));

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.on("error", onError);
  child.stdin?.on("error", onStdinError);
  child.on("close", onClose);

  child.stdin?.end(input);

  const exit = yield* settled.operation;
  if (!exit.ok) {
    throw exit.error;
  }
  const status = { ...exit.value, stdout: partial.stdout, stderr: partial.stderr };
  if (mode === "expect" && status.code !== 0) {
    throw new Error(
      `${launch.command} exited ${status.code ?? `on ${status.signal}`}\n` +
        `${channel("stdout", status.stdout)}\n${channel("stderr", status.stderr)}`,
    );
  }
  return status;
}

/**
 * End the child's whole process group, and do not return until it is gone.
 *
 * A child that already closed resolves immediately. Otherwise the group is
 * asked to terminate, given a bounded chance to close, then killed — and either
 * way this waits for the `close` event, which is the only thing that says the
 * process and its pipes are actually finished.
 *
 * A kill that was refused is not a process that stopped, so a group nothing
 * could be delivered to while the child is still reachable ends the run with
 * that fact rather than waiting on a `close` that is never coming.
 */
function* reap(child: ChildProcess, hasClosed: () => boolean): Operation<void> {
  const gone = withResolvers<void>();
  const onGone = (): void => gone.resolve();

  // `close`, and nothing else. An assigned `exitCode` or `signalCode` says the
  // process ended; it does not say the pipes this run inherited have, and the
  // capture is still reading them.
  child.on("close", onGone);
  try {
    if (hasClosed()) {
      return;
    }

    const pid = child.pid;

    if (pid !== undefined) {
      end(pid, "SIGTERM");
      const graceful = yield* timebox(TERMINATION_GRACE, () => gone.operation);
      if (!graceful.timeout) {
        return;
      }

      const killed = end(pid, "SIGKILL");
      if (killed === "refused" && isReachable(pid)) {
        throw new Error(`the launched process ${pid} could not be stopped: SIGKILL was refused`);
      }
    }

    yield* gone.operation;
  } finally {
    child.off("close", onGone);
  }
}

/** What one signal delivery established about what it was aimed at. */
type Delivery = "delivered" | "absent" | "refused";

/**
 * Signal the child's whole process group, falling back to the child itself.
 *
 * The group is the target, because a child that spawned its own children is
 * only gone once they are. But a group that reported nothing is not a group
 * that is empty: `detached` can fail, and the process may simply not lead one.
 * So a delivery the group did not accept, while the child is still reachable,
 * is retried against the child directly.
 */
function end(pid: number, name: "SIGTERM" | "SIGKILL"): Delivery {
  const group = deliver(-pid, name);
  if (group === "delivered" || !isReachable(pid)) {
    return group;
  }
  return deliver(pid, name);
}

/**
 * Send one signal by pid and report what that established.
 *
 * Deliberately not `child.kill()`. Deno's `node:child_process` marks a child as
 * killed after the first call and delivers nothing on any later one, so a child
 * that ignores the first signal could never be escalated through the handle.
 */
function deliver(target: number, name: "SIGTERM" | "SIGKILL"): Delivery {
  try {
    process.kill(target, name);
    return "delivered";
  } catch (error) {
    // Gone between the decision and the delivery is the outcome this was
    // asking for. Anything else is a delivery that did not happen, and is not
    // evidence of termination.
    return isNoSuchProcess(error) ? "absent" : "refused";
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ESRCH"
  );
}

/**
 * Whether a process still exists. Signal 0 delivers nothing: it asks the kernel
 * whether the pid is reachable, which is the whole question here.
 */
function isReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A timeout is a host observation, not a CLI outcome, so the report carries
 * what a diagnosis needs from the host: the machine's load — these deadlines
 * expire under contention, not by the child's own doing — and whatever each
 * channel received before the run was abandoned.
 */
function abandonedReport(label: string, limit: number, partial: PartialOutput): string {
  const load = loadavg()
    .map((average) => average.toFixed(1))
    .join(", ");
  return [
    `${label} timed out after ${limit}ms (load average ${load})`,
    channel("stdout", partial.stdout),
    channel("stderr", partial.stderr),
  ].join("\n");
}

function channel(name: string, content: string): string {
  return content.length === 0
    ? `--- ${name} before the deadline: nothing ---`
    : `--- ${name} before the deadline ---\n${content}`;
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

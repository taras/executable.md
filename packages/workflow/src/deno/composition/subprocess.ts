/**
 * One child process, run to completion, as an operation.
 *
 * Three callers need the same four things — a built environment rather than an
 * inherited one, output read to the end rather than to the exit, a nonzero exit
 * treated as an answer rather than a throw, and a cancellation that finishes
 * rather than merely starts. Native Git is one of them, the credential broker
 * is another and the Git-host login command is the third, so the discipline
 * lives here and each of them says only what it is running.
 */

import { ensure, type Operation, withResolvers } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import process from "node:process";

/** What one invocation reported. A nonzero exit is an answer, not a throw. */
export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The whole environment the child sees. Nothing is inherited around it. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Bytes handed to the command on standard input, or none.
   *
   * A commit message is authored text of any length, and a credential request
   * is a record with a blank line in it; an argument list is neither the place
   * to put either one nor a boundary that carries one unchanged.
   */
  readonly input?: string;
  /**
   * Handed the child as it is spawned, before anything is attached to it,
   * together with a reader for what has been captured from it so far.
   *
   * Package-private, for the cancellation regression: this is the only place a
   * baseline can be measured, and the cleanup is already established by the
   * time it is called.
   */
  readonly observe?: (
    child: ChildProcessByStdio<Writable | null, Readable, Readable>,
    captured: () => { stdout: string; stderr: string },
  ) => void;
}

export function* runProcess({
  command,
  args,
  cwd,
  env,
  input,
  observe,
}: ProcessInvocation): Operation<ProcessOutcome> {
  // `node:child_process` rather than the runtime's own global: this adapter is
  // selected by the host, not written against one, and `spawn` replaces the
  // child's environment outright when `env` is given — which is the whole point
  // of building one rather than inheriting it.
  // `detached` puts the child in a process group of its own, which is what makes
  // cancellation reach the whole of what it started. Native Git runs its
  // transport in a helper of its own — `git-remote-http` holds the connection —
  // and that grandchild inherits these pipes. Signalling only the process this
  // spawned would leave the helper alive holding them open, so the `close`
  // waited for below would never arrive and a cancelled operation would hang
  // instead of tearing down.
  const options = { cwd, env: { ...env }, detached: true };
  // One type for both spawns, so the child's own listeners can be removed
  // through it: the two `stdio` shapes differ only in whether standard input is
  // a pipe, and TypeScript's overloads make the union's `off` unresolvable.
  //
  // Declared before the cleanup below and assigned after it, because a child
  // that exists before its release is registered can be stranded: `yield*
  // ensure(...)` is itself a suspension, and an owner halted while it registers
  // unwinds with nothing on it.
  let child: ChildProcessByStdio<Writable | null, Readable, Readable> | undefined;

  let settled = false;
  // `close`, and nothing else. An assigned `exitCode` or `signalCode` says the
  // process ended; it does not say the pipes this operation inherited have.
  let closed = false;
  let stdout = "";
  let stderr = "";
  // Declared after what it reads, so an observer may call it at once rather
  // than only from a later turn.
  const captured = () => ({ stdout, stderr });

  const outcome = withResolvers<ProcessOutcome>();

  // A pipe the command stops reading is the command's answer, and its exit
  // status is what says so — but the write still fails, and an unhandled
  // stream error would take the process down rather than this operation.
  // Reporting it here lets `close` settle first when there is an exit to
  // report.
  const onStdinError = (error: Error): void => {
    outcome.reject(error);
  };
  const onStdout = (chunk: string): void => {
    stdout += chunk;
  };
  const onStderr = (chunk: string): void => {
    stderr += chunk;
  };
  // `close` rather than `exit`: it is the event that fires once both pipes have
  // ended, so what is read here is everything the command wrote rather than
  // whatever had arrived when it stopped.
  const onExit = (code: number | null): void => {
    closed = true;
    outcome.resolve({ code: code ?? -1, stdout, stderr });
  };
  const onFailure = (error: Error): void => {
    outcome.reject(error);
  };

  // Established before anything is attached, because `yield* ensure(...)` is
  // itself a suspension: an owner halted while it registers unwinds with no
  // cleanup on it, leaving the process running and every handler in place.
  //
  // Teardown waits for the child to close rather than only signalling it.
  // `kill` returns once the signal is queued, not once it has been delivered,
  // so a cleanup that returned there would let the scope that owns this command
  // finish while the process it started is still alive — and the disposable
  // directory it is working in is removed moments later. `close` is the event
  // that fires once the process is gone and both pipes have ended, which is
  // what makes cancellation complete rather than merely started. It observes
  // that with a listener of its own, so this cleanup depends on nothing the
  // body below may not have reached.
  yield* ensure(function* () {
    if (child === undefined) {
      return;
    }

    try {
      if (!settled) {
        // The group, so the transport helper goes with the command that
        // started it. A group that is already gone raises, and that is the
        // same answer as a group that was killed — the wait below is what
        // decides either way.
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }

        // Only `close` ends this wait. The handlers above stay attached
        // through it, so whatever the command writes on its way out is still
        // captured and a failure still reports.
        if (!closed) {
          const gone = withResolvers<void>();
          const onGone = (): void => gone.resolve();

          child.on("close", onGone);
          try {
            if (!closed) {
              yield* gone.operation;
            }
          } finally {
            child.off("close", onGone);
          }
        }
      }
    } finally {
      // After the wait, and synchronously. Removing a handler that was never
      // attached is a no-op, which is what lets this be armed before the child
      // exists.
      child.off("close", onExit);
      child.off("error", onFailure);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin?.off("error", onStdinError);
    }
  });

  child =
    input === undefined
      ? spawnChild(command, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] })
      : spawnChild(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });

  observe?.(child, captured);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.on("close", onExit);
  child.on("error", onFailure);
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  if (input !== undefined && child.stdin !== null) {
    child.stdin.on("error", onStdinError);
    child.stdin.end(input, "utf8");
  }

  const result = yield* outcome.operation;
  settled = true;
  return result;
}

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
}

export function* runProcess({
  command,
  args,
  cwd,
  env,
  input,
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
  const child =
    input === undefined
      ? spawnChild(command, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] })
      : spawnChild(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });

  // Registered with no suspension point between spawning and registering, so a
  // halt cannot land between the two and leave a process running after the
  // scope that started it is gone.
  //
  // Teardown waits for the child to close rather than only signalling it.
  // `kill` returns once the signal is queued, not once it has been delivered,
  // so a cleanup that returned there would let the scope that owns this command
  // finish while the process it started is still alive — and the disposable
  // directory it is working in is removed moments later. `close` is the event
  // that fires once the process is gone and both pipes have ended, which is
  // what makes cancellation complete rather than merely started.
  let settled = false;
  const closed = withResolvers<void>();
  child.on("close", () => closed.resolve());
  yield* ensure(function* () {
    if (settled) {
      return;
    }
    // The group, so the transport helper goes with the command that started it.
    // A group that is already gone raises, and that is the same answer as a
    // group that was killed — the wait below is what decides either way.
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
    yield* closed.operation;
  });

  const outcome = withResolvers<ProcessOutcome>();
  if (input !== undefined && child.stdin !== null) {
    // A pipe the command stops reading is the command's answer, and its exit
    // status is what says so — but the write still fails, and an unhandled
    // stream error would take the process down rather than this operation.
    // Reporting it here lets `close` settle first when there is an exit to
    // report.
    child.stdin.on("error", (error: Error) => {
      outcome.reject(error);
    });
    child.stdin.end(input, "utf8");
  }
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // `close` rather than `exit`: it is the event that fires once both pipes have
  // ended, so what is read here is everything the command wrote rather than
  // whatever had arrived when it stopped.
  child.on("close", (code: number | null) => {
    outcome.resolve({ code: code ?? -1, stdout, stderr });
  });
  child.on("error", (error: Error) => {
    outcome.reject(error);
  });

  const result = yield* outcome.operation;
  settled = true;
  return result;
}

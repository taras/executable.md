/**
 * Run a command so its process tree cannot outlive the calling scope.
 *
 * `exec` from @effectionx/process suspends between creating the child process
 * and registering the teardown that terminates it, so a halt arriving in that
 * window leaves the process running with nothing owning it. Here the
 * terminate-and-join teardown is registered before the process exists and the
 * process is created in the same synchronous continuation, so a halt lands
 * either before there is anything to clean up or after the cleanup is armed —
 * never between.
 *
 * The child is detached into its own process group and teardown signals the
 * whole group, then joins the child's `close` event, which settles only when
 * every holder of the child's piped stderr has exited — grandchildren
 * included. Cleanup registered before this call therefore runs strictly after
 * the tree is gone.
 */

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { ensure, withResolvers } from "effection";
import type { Operation } from "effection";

export interface ContainedExit {
  code: number | null;
  signal: string | null;
  stderr: string;
}

interface Exit {
  code: number | null;
  signal: string | null;
}

export function* containedRun(
  command: string,
  args: string[],
  options: { cwd: string },
): Operation<ContainedExit> {
  const closed = withResolvers<Exit>();
  let pid: number | undefined;
  let exited = false;
  let failed: Error | undefined;
  yield* ensure(function* () {
    if (pid === undefined) {
      return;
    }
    if (!exited) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // the group ended between the exit observation and the signal
      }
    }
    yield* closed.operation;
  });
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: Uint8Array[] = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk: Uint8Array) => stderr.push(chunk));
  }
  child.once("error", (error: Error) => {
    exited = true;
    failed = error;
    closed.resolve({ code: null, signal: null });
  });
  child.once("close", (code: number | null, signal: string | null) => {
    exited = true;
    closed.resolve({ code, signal });
  });
  pid = child.pid;
  const exit = yield* closed.operation;
  if (failed) {
    throw failed;
  }
  return { ...exit, stderr: Buffer.concat(stderr).toString("utf8") };
}

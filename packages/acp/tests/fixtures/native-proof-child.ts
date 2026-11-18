import { ensure, scoped, race, withResolvers } from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ChildOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Every child a mode started, so cleanup can prove none outlived it. */
export type LiveSet = Set<number>;

/** Run one captured child to settlement. Never the production command. */
export function runChild(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; live: LiveSet; env?: Record<string, string> },
): Operation<ChildOutcome> {
  return scoped(function* () {
    const settled = withResolvers<ChildOutcome>();
    const failed = withResolvers<never>();
    let child: ChildProcess | undefined;
    let stdout = "";
    let stderr = "";
    let closed = false;
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onError = (error: Error) => failed.reject(error);
    const onClose = (code: number | null, signal: string | null) => {
      closed = true;
      settled.resolve({ code, signal, stdout, stderr });
    };
    yield* ensure(function* () {
      if (!child) {
        return;
      }
      try {
        if (!closed) {
          if (child.pid) {
            child.kill("SIGKILL");
          }
          yield* settled.operation;
        }
      } finally {
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.off("error", onError);
        child.off("close", onClose);
        if (child.pid) {
          options.live.delete(child.pid);
        }
      }
    });
    child = spawnChild(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (child.pid) {
      options.live.add(child.pid);
    }
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    child.stdin?.end(options.input);
    return yield* race([settled.operation, failed.operation]);
  });
}

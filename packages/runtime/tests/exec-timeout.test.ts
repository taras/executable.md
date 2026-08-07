/**
 * Exec settles on the command's exit, not on stdio EOF (#343).
 *
 * `close`-settled execution resolves only after exit AND pipe EOF, so a pipe
 * fd held open past the deadline — an inherited fd in a straggling
 * grandchild, or stream delivery lagging on a loaded host — turns a command
 * that finished within its budget into a timeout and discards the output it
 * already produced. The budget must bound the command's own lifetime.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@executablemd/runtime";

describe("Process.exec timeout semantics", () => {
  // The straggler inherits the stdout pipe and would hold EOF open for 30s,
  // far past the 1s budget. Close-settled execution reports this command as
  // timed out and loses "partial"; exit-settled execution returns the exit
  // code and the printed output, and reaps the straggler with the group.
  it("delivers a completed command's output while a straggler holds the pipe", function* () {
    const result = yield* exec({
      command: ["bash", "-c", "(sleep 30 &); echo partial; exit 1"],
      timeout: 1_000,
    });

    expect(result.stdout).toContain("partial");
    expect(result.exitCode).toBe(1);
  });

  it("still times out a command that outlives its budget", function* () {
    let error: Error | undefined;
    try {
      yield* exec({ command: ["bash", "-c", "sleep 30"], timeout: 250 });
    } catch (raised) {
      error = raised instanceof Error ? raised : new Error(String(raised));
    }

    expect(error?.message).toContain("exec(bash) timed out after 250ms");
  });
});

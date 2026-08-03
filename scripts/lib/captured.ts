/**
 * Run a command and keep its output instead of letting it out.
 *
 * `exec(...).join()` collects stdout and stderr *and* forwards them to this
 * process as they arrive. Three test suites running at once would then
 * interleave three streams of output into one terminal, and the failure worth
 * reading would be shredded across the other two.
 *
 * Middleware that never calls `next` is what makes a run quiet: the bytes
 * arrive here and go nowhere else, so the caller decides what to show and when.
 */

import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import type { ExecOptions } from "@effectionx/process";

export interface Captured {
  /** A process killed by a signal reports no code, and that is not success. */
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams in the order they arrived, for showing a human. */
  output: string;
}

/**
 * The streams stay apart as well as together: a caller parsing NUL-delimited
 * output cannot afford a warning written to stderr landing in the middle of it.
 */
export function* captured(command: string, options: ExecOptions): Operation<Captured> {
  const decoder = new TextDecoder();
  const out: string[] = [];
  const err: string[] = [];
  const both: string[] = [];

  const process = yield* exec(command, options);
  yield* process.around({
    *stdout([bytes]) {
      const text = decoder.decode(bytes);
      out.push(text);
      both.push(text);
    },
    *stderr([bytes]) {
      const text = decoder.decode(bytes);
      err.push(text);
      both.push(text);
    },
  });

  const status = yield* process.join();
  return {
    code: status.code ?? 1,
    stdout: out.join(""),
    stderr: err.join(""),
    output: both.join(""),
  };
}

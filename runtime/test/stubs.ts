/**
 * Composable test stubs for runtime context APIs.
 *
 * These helpers install `around()` middleware on the runtime context APIs
 * to replace real I/O with in-memory implementations. They are scoped to
 * the current Effection scope — call them before `runDocument()` or
 * `durableRun()` in your test body.
 *
 * @example
 * ```typescript
 * import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
 *
 * it("runs a document with stubbed I/O", function* () {
 *   yield* useStubFs({ "doc.md": "# Hello\n" });
 *   yield* useEchoExec();
 *
 *   const execution = yield* runDocument({ docPath: "doc.md", stream });
 *   const output = yield* execution;
 * });
 * ```
 */

import type { Operation } from "effection";
import { API } from "../apis.ts";
import type { StatResult } from "../apis.ts";

/**
 * Install an in-memory filesystem stub.
 *
 * - `readTextFile` returns content from the `files` map; throws ENOENT for missing keys.
 * - `stat` returns `{ exists: true, isFile: true }` for keys in the map.
 * - `glob` throws (not stubbed). Install `API.Fs.around()` directly if needed.
 *
 * The `files` object is captured **by reference** — mutating it between
 * operations changes what `readTextFile`/`stat` see. This is useful for
 * testing file changes between runs.
 */
export function* useStubFs(files: Record<string, string>): Operation<void> {
  yield* API.Fs.around({
    *readTextFile([path], _next) {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      return content;
    },
    *stat([path], _next): Operation<StatResult> {
      const exists = path in files;
      return { exists, isFile: exists, isDirectory: false };
    },
    *glob(_args, _next) {
      throw new Error("glob not stubbed");
    },
  });
}

/**
 * Install a simple exec stub that handles `echo` commands.
 *
 * Recognizes `bash -c "echo ..."` and returns the echo'd text as stdout.
 * All other commands return the script text as stdout with exit code 0.
 */
export function* useEchoExec(): Operation<void> {
  yield* API.Process.around({
    *exec([options], _next) {
      const script = (options.command[2] ?? "").trim();
      if (script.startsWith("echo ")) {
        return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: script + "\n", stderr: "" };
    },
  });
}

/**
 * Install an exec stub that always returns the given exit code and stderr.
 *
 * Useful for testing error handling paths.
 */
export function* useFailingExec(exitCode: number, stderr = "command failed"): Operation<void> {
  yield* API.Process.around({
    *exec(_args, _next) {
      return { exitCode, stdout: "", stderr };
    },
  });
}

/**
 * Composable test stubs for runtime context APIs.
 *
 * These helpers install `around()` middleware on the runtime context APIs
 * to replace real I/O with in-memory implementations. They are scoped to
 * the current Effection scope — call them before `execute()` or
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
 *   const execution = yield* execute({ path: "doc.md", stream });
 *   const output = yield* execution;
 * });
 * ```
 */

import type { Operation } from "effection";
import { Stdio } from "@effectionx/process";
import { API } from "../apis.ts";
import type { LinkStatResult, StatResult } from "../apis.ts";
import { SERVICE_HOSTNAME } from "../service.ts";
import type { ServiceEndpoint } from "../service.ts";

/** Install a provider-neutral scoped service attachment stub. */
export function* useStubService(endpoint: ServiceEndpoint): Operation<void> {
  if (endpoint.hostname !== SERVICE_HOSTNAME) {
    throw new Error("stub service endpoint must use 127.0.0.1");
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
    throw new Error("stub service endpoint port must be an integer from 1 through 65535");
  }
  const exact = Object.freeze({ hostname: SERVICE_HOSTNAME, port: endpoint.port });
  yield* API.Service.around({
    // deno-lint-ignore require-yield
    *start() {
      return { endpoint: exact };
    },
  });
}

/**
 * Install an in-memory filesystem stub.
 *
 * - `readTextFile` returns content from the `files` map; throws ENOENT for missing keys.
 * - `stat` returns `{ exists: true, isFile: true }` for keys in the map.
 * - `lstat` answers the same, with `isSymbolicLink: false`: an in-memory map
 *   holds file content, so nothing in it is a link to somewhere else.
 * - `readDirectory` and `glob` throw (not stubbed). An in-memory map of file
 *   paths holds no directory structure, so answering either from it would
 *   invent one; install `API.Fs.around()` directly when a test needs to
 *   enumerate.
 * - the writing half — `writeTextFile`, `ensureDir`, `rename`, `remove`, and
 *   `realpath` — is not stubbed and reaches the real filesystem. A test that
 *   exercises a document writing files wants a real temporary directory.
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
    *lstat([path], _next): Operation<LinkStatResult> {
      const exists = path in files;
      return { exists, isFile: exists, isDirectory: false, isSymbolicLink: false };
    },
    *readDirectory(_args, _next) {
      throw new Error("readDirectory not stubbed");
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
 *
 * It answers like a real child: the text is written to the stdio chain as it
 * "arrives", so whatever encloses the call sees it the way it would see a
 * child's, and it is retained in the outcome only when the caller asked
 * for retention. A stub that always returned strings would let a document
 * render output the contract says was already displayed.
 */
export function* useEchoExec(): Operation<void> {
  yield* API.Process.around({
    *exec([options], _next) {
      const script = (options.command[2] ?? "").trim();
      const text = script.startsWith("echo ") ? script.slice(5) + "\n" : script + "\n";
      yield* Stdio.operations.stdout(encoder.encode(text));
      return retained(options, { exitCode: 0, stdout: text, stderr: "" });
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
    *exec([options], _next) {
      yield* Stdio.operations.stderr(encoder.encode(stderr));
      return retained(options, { exitCode, stdout: "", stderr });
    },
  });
}

const encoder = new TextEncoder();

/** What the caller asked to keep, so a stub cannot retain more than a call would. */
function retained(
  options: { retain?: boolean },
  outcome: { exitCode: number; stdout: string; stderr: string },
): { exitCode: number; stdout: string | undefined; stderr: string | undefined } {
  if (options.retain === false) {
    return { exitCode: outcome.exitCode, stdout: undefined, stderr: undefined };
  }
  return outcome;
}

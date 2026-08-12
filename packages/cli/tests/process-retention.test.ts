/**
 * Tier FG — which host paths keep what a command printed.
 *
 * Retention is stated by the path that starts a run, never inferred from a
 * pathname. `xmd run` and `xmd test` keep a command's output when the caller
 * asked for a diagnostic trace, and keep none otherwise. The record is what
 * these assert: displayed output is identical whichever way this is decided,
 * which is exactly how it would go wrong unnoticed.
 *
 * The workflow path, which owns a journal without naming one, is
 * `workflow-retention.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";

/** One command, two channels, both distinctive. */
const DOCUMENT = [
  "# Prints",
  "",
  "```bash exec",
  `printf 'to-out'; printf 'to-err' >&2`,
  "```",
  "",
].join("\n");

/** A directory holding the document, with no repository behind it. */
function useDocument<T>(body: (dir: string) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const dir = join(tmpdir(), `xmd-fgr-${randomUUID()}`);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* ensureDir(dir);
    yield* writeTextFile(join(dir, "prints.md"), DOCUMENT);
    return yield* body(dir);
  });
}

/**
 * The `--verbose` echo of the run's exec record, without its colours.
 *
 * The echo is written for a person, so the values are highlighted; what is
 * asserted here is the record it is echoing.
 */
function echoedExec(stderr: string): string {
  // deno-lint-ignore no-control-regex
  const plain = stderr.replace(/\[[0-9;]*m/g, "");
  const line = plain.split("\n").find((entry) => entry.includes("[yield] exec:"));
  if (line === undefined) {
    throw new Error(`no exec entry in:\n${plain}`);
  }
  return line;
}

describe("Tier FG — host retention", () => {
  it("FG20: xmd run without --journal keeps the status and neither channel", function* () {
    yield* useDocument(function* (dir) {
      // A home of its own: a developer's shell startup file greeting the run
      // would be the child's stderr too, and this asserts the exact record.
      const result = yield* runCli(["run", "prints.md", "--verbose"], {
        cwd: dir,
        env: { HOME: dir },
      }).join();

      expect(result.code).toBe(0);
      // Forwarded to the reader as it ran — routing is not retention.
      expect(result.stderr).toContain("to-err");
      const echoed = echoedExec(result.stderr);
      expect(echoed).toContain("exitCode: 0");
      expect(echoed).toContain("stdout: undefined");
      expect(echoed).toContain("stderr: undefined");
    });
  });

  it("FG21: xmd run with --journal keeps both channels", function* () {
    yield* useDocument(function* (dir) {
      const trace = join(dir, "trace.jsonl");
      const result = yield* runCli(["run", "prints.md", "--verbose", "--journal", trace], {
        cwd: dir,
        env: { HOME: dir },
      }).join();

      expect(result.code).toBe(0);
      const echoed = echoedExec(result.stderr);
      expect(echoed).toContain("stdout: 'to-out'");
      expect(echoed).toContain("stderr: 'to-err'");
    });
  });
});

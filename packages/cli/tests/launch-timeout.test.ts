/**
 * The harness deadline in `@executablemd/test-support/launch`.
 *
 * `runCli` bounds every suite's `xmd` subprocess, and its deadline expires
 * under host contention rather than by the child's own doing — so when it
 * does, the failure it raises is the only record the suite gets of that run.
 * This proves the record carries what a diagnosis needs: the deadline, and
 * whatever the child wrote on each channel before the run was abandoned.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliRuntime, runCli } from "@executablemd/test-support/launch";

// The deadline must expire for the failure to exist, so this test always costs
// its whole limit — kept as small as the slowest host launch leaves safe.
const LIMIT = cliRuntime() === "node" ? 20_000 : 10_000;

/** Says its name on each channel, then outlives the deadline. */
const LINGERING = [
  "# Lingering",
  "",
  "```bash exec",
  "printf 'lingering-out'; printf 'lingering-err' >&2; sleep 120",
  "```",
  "",
].join("\n");

/** A directory holding the document, with no repository behind it. */
function useDocument<T>(body: (dir: string) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const dir = join(tmpdir(), `xmd-deadline-${randomUUID()}`);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* ensureDir(dir);
    yield* writeTextFile(join(dir, "lingering.md"), LINGERING);
    return yield* body(dir);
  });
}

describe("Harness deadline — an abandoned xmd run keeps its account", () => {
  it("the failure names the deadline and carries both channels", function* () {
    yield* useDocument(function* (dir) {
      let failure: Error | undefined;
      try {
        yield* runCli(["run", "lingering.md"], { cwd: dir, timeout: LIMIT }).join();
      } catch (error) {
        failure = error as Error;
      }

      expect(failure?.message).toContain(`timed out after ${LIMIT}ms`);
      expect(failure?.message).toContain("lingering-out");
      expect(failure?.message).toContain("lingering-err");
    });
  });
});

/**
 * Tier XT — the CLI timeout reaches executable code blocks (#153).
 *
 * `--timeout` sets the contextual timeout, and an `exec` block is bounded by
 * it. The suite shells out because the path under test is the whole one — a
 * command line, the Config install beside the agent stack, and the duration the
 * Process Api resolves for a block that named none.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "@executablemd/test-support/launch";

function* useDocument<T>(body: string, run: (dir: string) => Operation<T>): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-xt-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "doc.md"), body);
    return yield* run(dir);
  });
}

const SLOW = ["# Doc", "", "```bash exec", "sleep 3 && echo SLOW_DONE", "```", ""].join("\n");

const RAISED = [
  "# Doc",
  "",
  "```bash timeout=5s exec",
  "sleep 1.5 && echo RAISED_DONE",
  "```",
  "",
].join("\n");

const INHERITED = [
  "# Doc",
  "",
  "```bash timeout exec",
  "sleep 3 && echo INHERITED_DONE",
  "```",
  "",
].join("\n");

describe("Tier XT — CLI timeout for code blocks", () => {
  it("XT1: --timeout bounds a block that declares no duration", function* () {
    yield* useDocument(SLOW, function* (dir) {
      const { stdout } = yield* runCli(["run", "doc.md", "--timeout", "1", "--raw"], {
        cwd: dir,
      }).join();
      expect(stdout).toContain("timed out after 1000ms");
      expect(stdout).not.toContain("SLOW_DONE");
    });
  });

  it("XT2: a block's own duration outranks a shorter --timeout", function* () {
    yield* useDocument(RAISED, function* (dir) {
      const { stdout } = yield* runCli(["run", "doc.md", "--timeout", "1", "--raw"], {
        cwd: dir,
      }).join();
      expect(stdout).toContain("RAISED_DONE");
      expect(stdout).not.toContain("timed out");
    });
  });

  it("XT3: a timeout modifier that names no duration inherits --timeout", function* () {
    yield* useDocument(INHERITED, function* (dir) {
      const { stdout } = yield* runCli(["run", "doc.md", "--timeout", "1", "--raw"], {
        cwd: dir,
      }).join();
      expect(stdout).toContain("timed out after 1000ms");
      expect(stdout).not.toContain("INHERITED_DONE");
    });
  });
});

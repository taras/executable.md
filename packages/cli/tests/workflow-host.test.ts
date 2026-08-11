/**
 * Tier WFH — which hosts run a workflow.
 *
 * `xmd workflow` has the same grammar everywhere and the capability in one
 * place. Deno and the compiled binary own the local run store; Node and Bun
 * expose the command and refuse it before anything is created or executed, so
 * a caller learns the boundary from one sentence rather than from a run that
 * half-happened.
 *
 * Which entrypoint is under test is asked of `@executablemd/test-support`,
 * which is the one place runtime detection belongs.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliRuntime, runCli } from "@executablemd/test-support/launch";

/** The one sentence a host without workflow support says. */
const UNSUPPORTED =
  "xmd workflow is available only through the Deno entrypoint or compiled xmd binary";

const DOCUMENT = ["# Nothing", "", "no effects at all", ""].join("\n");

interface Fixture {
  readonly dir: string;
  readonly runs: string;
  readonly home: string;
}

function useFixture<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfh-${randomUUID()}`);
    const fixture: Fixture = {
      dir: join(root, "work"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.dir);
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.dir, "flow.md"), DOCUMENT);
    return yield* body(fixture);
  });
}

describe("Tier WFH — workflow host boundary", () => {
  it("WFH1: an unsupported host refuses before creating or executing anything", function* () {
    yield* useFixture(function* (fixture) {
      const result = yield* runCli(["workflow", "start", "flow.md"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      if (cliRuntime() === "deno") {
        // The Deno entrypoint has the capability. What it refuses here is the
        // definition — the fixture is not in a repository — which is a
        // different sentence and a different reason.
        expect(result.stderr).not.toContain(UNSUPPORTED);
        return;
      }

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(UNSUPPORTED);
      // Nothing was created: no run store, and no `workflow run:` line, so no
      // run id was ever allocated.
      expect(result.stderr).not.toContain("workflow run:");
      expect(result.stderr).not.toContain("workflow status:");
      expect(yield* exists(fixture.runs)).toBe(false);
    });
  });

  it("WFH2: every host reads the same grammar", function* () {
    yield* useFixture(function* (fixture) {
      const help = yield* runCli(["workflow", "--help"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      expect(help.code).toBe(0);
      expect(help.stdout).toContain("xmd workflow");
      expect(help.stdout).toContain("--id");
    });
  });

  it("WFH3: an unsupported host refuses a resume too, and reads no store", function* () {
    yield* useFixture(function* (fixture) {
      const result = yield* runCli(["workflow", "resume", "any-run"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      expect(result.code).toBe(1);
      if (cliRuntime() === "deno") {
        expect(result.stderr).toContain("any-run");
        return;
      }
      expect(result.stderr).toContain(UNSUPPORTED);
      expect(yield* exists(fixture.runs)).toBe(false);
    });
  });
});

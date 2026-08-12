/**
 * Tier FG — what a workflow run retains (§3.6).
 *
 * A workflow owns its journal and names none, so retention cannot be read off a
 * `--journal` pathname: its process results are part of the run's retained
 * history, which is what a resumed procedure reads back instead of running the
 * command again. The record is asserted, because displayed output is identical
 * either way.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runCli } from "@executablemd/test-support/launch";
import { workflowRunPath } from "@executablemd/workflow/deno";

/** One command, two channels, both distinctive. */
const DOCUMENT = [
  "# Prints",
  "",
  "```bash exec",
  `printf 'to-out'; printf 'to-err' >&2`,
  "```",
  "",
].join("\n");

const RUN_ID = "retention-run";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useFixture<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-fgw-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(join(fixture.repository, "flows"));
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.repository, "flows/prints.md"), DOCUMENT);

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-fg@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier FG"]);
    yield* git(fixture.repository, ["add", "-A"]);
    // The fixture is not the developer's repository: whatever signing their own
    // configuration asks for is not this commit's business.
    yield* git(fixture.repository, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "definition",
    ]);

    return yield* body(fixture);
  });
}

/** The exec record a run committed, as a second connection reads it. */
function committedExec(path: string): { exitCode?: number; stdout?: string; stderr?: string } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("SELECT record FROM journal_events ORDER BY sequence").all();
    for (const row of rows) {
      const record = typeof row["record"] === "string" ? row["record"] : "";
      const parsed = JSON.parse(record);
      if (parsed?.description?.type === "exec" && parsed?.result?.status === "ok") {
        return parsed.result.value;
      }
    }
    throw new Error("no committed exec record");
  } finally {
    database.close();
  }
}

describe("Tier FG — workflow retention", () => {
  /**
   * A workflow names no `--journal`: it owns its stream. A run that read the
   * absent pathname as "keep nothing" would leave every process result in the
   * retained history empty, and a resume would read back a command it can no
   * longer see the output of.
   */
  it("FG22: a workflow run retains its process results without naming a journal", function* () {
    yield* useFixture(function* (fixture) {
      const result = yield* runCli(["workflow", "start", `--id=${RUN_ID}`, "flows/prints.md"], {
        cwd: fixture.repository,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      expect(result.code).toBe(0);

      const committed = committedExec(workflowRunPath(fixture.runs, RUN_ID));
      expect(committed.exitCode).toBe(0);
      expect(committed.stdout).toBe("to-out");
      expect(committed.stderr).toBe("to-err");
    });
  });
});

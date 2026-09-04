/**
 * Tier EP — one `<Evaluate>` per execution (issue #713).
 *
 * A workflow run declares an `<Evaluate>` of its own, and the run profile must
 * not declare a second component of that name beside it. This is its own file
 * because proving it needs `xmd workflow start`, which exists on the Deno
 * entrypoints alone: under Node and Bun the command refuses before a run is
 * created, so the case would assert nothing there. Tier EP's portable half is
 * `evaluate-program-component.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A workflow run declares an `<Evaluate>` of its own — the complete-program
 * forms plus the restricted generated-fragment form only that profile has. The
 * run profile must not declare a second component of that name beside it: one
 * name names durable work in one domain, and canonical execution refuses two.
 *
 * This is the seam where that goes wrong, because it is the CLI's own
 * installation array rather than anything either package assembles alone.
 */
const WORKFLOW_PROGRAM = [
  "# Compose",
  "",
  '<Let value={"# Composed\\n\\nThe workflow program ran.\\n"} as="plan" />',
  "",
  "<Evaluate program={plan} />",
  "",
].join("\n");

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

function useWorkflowFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-ep-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);
    for (const [name, content] of Object.entries(files)) {
      const path = join(fixture.repository, name);
      yield* ensureDir(join(path, ".."));
      yield* writeTextFile(path, content);
    }
    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-ep@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier EP"]);
    yield* git(fixture.repository, ["add", "-A"]);
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

describe(
  "Tier EP — one `<Evaluate>` per execution",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("EP9: a workflow run keeps its own `<Evaluate>` and gains no second one", function* () {
      yield* useWorkflowFixture({ "flows/compose.md": WORKFLOW_PROGRAM }, function* (fixture) {
        const started = yield* runCli(["workflow", "start", "--id=compose-1", "flows/compose.md"], {
          cwd: fixture.repository,
          env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        }).join();

        const reported = `${started.stdout}${started.stderr}`;
        // The exact sentence canonical execution refuses a duplicate with. A
        // run profile that declared its own beside the workflow's would fail
        // every workflow run, not only one that writes `<Evaluate>`.
        expect(reported).not.toContain('two identity components called "Evaluate"');
        expect(reported).toContain("The workflow program ran.");
      });
    });
  },
);

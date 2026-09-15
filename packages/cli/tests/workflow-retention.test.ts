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
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
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

/**
 * Tier FG — the source a run retains, after the file it came from is gone.
 *
 * The bytes are the run. So the cases here take the original away in each of
 * the three ways a caller can — edit it, move it, delete it — and then ask the
 * run to continue. It continues from what it kept, every time, and a second
 * start of the same bytes under the same logical name is the same run wherever
 * on this machine those bytes now happen to sit.
 */
describe("Tier FG — retained source", () => {
  /** A line only the retained document says, so a replay of it is visible. */
  const RETAINED_LINE = "this line is the retained source";
  const RETAINED = [
    "# Retained",
    "",
    RETAINED_LINE,
    "",
    "```bash exec",
    `printf 'retained-output'`,
    "```",
    "",
  ].join("\n");

  function* startRetained(fixture: Fixture, id: string, at: string): Operation<void> {
    const started = yield* runCli(["workflow", "start", `--id=${id}`, at], {
      cwd: fixture.repository,
      env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
    }).join();
    expect(started.code).toBe(0);
  }

  function resume(fixture: Fixture, id: string) {
    return runCli(["workflow", "resume", id], {
      cwd: fixture.repository,
      env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
    }).join();
  }

  /** One way a caller can take the original away, and what it is called. */
  interface Disturbance {
    readonly name: string;
    disturb(fixture: Fixture, at: string): Operation<void>;
  }

  const DISTURBANCES: readonly Disturbance[] = [
    {
      name: "edited",
      *disturb(_fixture: Fixture, at: string): Operation<void> {
        yield* writeTextFile(at, "# Something else entirely\n");
      },
    },
    {
      name: "moved",
      *disturb(fixture: Fixture, at: string): Operation<void> {
        yield* writeTextFile(join(fixture.repository, "flows/moved.md"), RETAINED);
        yield* rm(at, { force: true });
      },
    },
    {
      name: "deleted",
      *disturb(_fixture: Fixture, at: string): Operation<void> {
        yield* rm(at, { force: true });
      },
    },
  ];

  it("FG40: an edited, moved or deleted original changes nothing about the run", function* () {
    for (const { name, disturb } of DISTURBANCES) {
      yield* useFixture(function* (fixture) {
        const at = join(fixture.repository, "flows/retained.md");
        yield* writeTextFile(at, RETAINED);
        yield* startRetained(fixture, `retained-${name}`, at);

        yield* disturb(fixture, at);

        const resumed = yield* resume(fixture, `retained-${name}`);
        expect({ name, code: resumed.code }).toEqual({ name, code: 0 });
        // The retained document, rendered from the run rather than from a file
        // that no longer says it — or no longer exists at all.
        expect(resumed.stdout).toContain(RETAINED_LINE);
        expect(resumed.stdout).not.toContain("Something else entirely");
        // And the command's own retained result, which is what a replay reads
        // back instead of running it again.
        expect(committedExec(workflowRunPath(fixture.runs, `retained-${name}`)).stdout).toBe(
          "retained-output",
        );
      });
    }
  });

  it("FG43: a damaged retained source refuses, and never falls back to the file", function* () {
    yield* useFixture(function* (fixture) {
      const at = join(fixture.repository, "flows/fallback.md");
      yield* writeTextFile(at, RETAINED);
      yield* startRetained(fixture, "fallback-1", at);

      // The run's own retained content stops describing itself. The file it was
      // started from is untouched and still says exactly what it always said —
      // which is the whole point: a resume that read it would succeed, and a
      // resume that must not read it refuses.
      const store = workflowRunPath(fixture.runs, "fallback-1");
      const database = new DatabaseSync(store);
      try {
        const row = database.prepare("SELECT content FROM workflow_definition_blob").get();
        const bytes = row?.["content"];
        if (!(bytes instanceof Uint8Array)) {
          throw new Error("the run retains no source bytes");
        }
        const altered = Uint8Array.from(bytes);
        altered[0] = altered[0] === 0x23 ? 0x2a : 0x23;
        database.prepare("UPDATE workflow_definition_blob SET content = ?").run(altered);
      } finally {
        database.close();
      }
      expect(yield* readTextFile(at)).toBe(RETAINED);

      const resumed = yield* resume(fixture, "fallback-1");
      expect(resumed.code).toBe(1);
      expect(resumed.stderr).toContain("disagrees with its own descriptor");
      expect(resumed.stdout).not.toContain(RETAINED_LINE);
    });
  });

  it("FG42: another entrypoint, or other bytes, is another run and conflicts", function* () {
    yield* useFixture(function* (fixture) {
      yield* writeTextFile(join(fixture.repository, "flows/named.md"), RETAINED);
      yield* startRetained(fixture, "named-1", join(fixture.repository, "flows/named.md"));

      const environment = { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs };

      // The same bytes under a different logical name: a different definition,
      // because source positions and later relative references use the name.
      yield* writeTextFile(join(fixture.repository, "flows/renamed.md"), RETAINED);
      const renamed = yield* runCli(
        ["workflow", "start", "--id=named-1", join(fixture.repository, "flows/renamed.md")],
        { cwd: fixture.repository, env: environment },
      ).join();
      expect(renamed.code).toBe(1);
      expect(renamed.stderr).toContain("definition");

      // The same name over different bytes: also a different definition.
      yield* writeTextFile(join(fixture.home, "named.md"), `${RETAINED}\nand one more line\n`);
      const changed = yield* runCli(
        ["workflow", "start", "--id=named-1", join(fixture.home, "named.md")],
        { cwd: fixture.repository, env: environment },
      ).join();
      expect(changed.code).toBe(1);
      expect(changed.stderr).toContain("definition");
    });
  });
});

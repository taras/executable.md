/**
 * Tier WFX — what a killed `xmd workflow start` leaves, and what a resume does
 * with it.
 *
 * The point of a retained workflow is that losing the host is survivable, so
 * this is made of real processes and a real `SIGKILL`. Nothing runs after the
 * signal — no cleanup, no commit, no rollback — and what the next process finds
 * is whatever the last committed transaction left.
 *
 * The document writes many files, one durable effect each, and the parent kills
 * the child once a second connection can see that some of them have committed.
 * Where the kill lands is deliberately not controlled: it may fall between two
 * effects, or inside one whose transaction has not committed. Both are real, and
 * the invariant that has to hold either way is the one asserted — every effect
 * appears exactly once, in order, with no duplicate and no gap, and the effects
 * that committed before the kill are not performed again.
 *
 * The stricter in-transaction kill, where the child is stopped at a point it has
 * announced from inside an open transaction, is Tier WAC's
 * (`packages/workflow/tests/workspace-crash-recovery.test.ts`). This suite is
 * about the CLI lifecycle built on top of it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { when } from "@effectionx/converge";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { cliCommand, runCli } from "@executablemd/test-support/launch";
import { workflowRunPath } from "@executablemd/workflow/deno";

/** Enough effects that a kill lands part-way through rather than after. */
const EFFECTS = 60;

const RUN_ID = "crashed-run";

function definition(): string {
  const lines = ["# Many effects", ""];
  for (let index = 0; index < EFFECTS; index += 1) {
    lines.push(`<File path="out/f${index}.txt">effect ${index}</File>`, "");
  }
  return lines.join("\n");
}

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
    const root = join(tmpdir(), `xmd-wfx-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(join(fixture.repository, "flows"));
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.repository, "flows/many.md"), definition());

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wfx@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFX"]);
    yield* git(fixture.repository, ["add", "-A"]);
    yield* git(fixture.repository, ["commit", "-q", "-m", "definition"]);

    return yield* body(fixture);
  });
}

interface FileEffect {
  readonly eventId: string;
  readonly name: string;
}

/**
 * The file effects a second connection can see, in append order.
 *
 * Read from outside the running process on purpose: rows inside an open
 * transaction are invisible here until that transaction commits, so this
 * reports what has been *published* rather than what some handle is holding.
 */
function committedEffects(path: string): FileEffect[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT event_id AS id, record FROM journal_events ORDER BY sequence")
      .all();
    const effects: FileEffect[] = [];
    for (const row of rows) {
      const record = typeof row["record"] === "string" ? row["record"] : "";
      const parsed = JSON.parse(record);
      const description = parsed?.description;
      if (description?.type === "workspace_file" && typeof description.name === "string") {
        effects.push({ eventId: String(row["id"]), name: description.name });
      }
    }
    return effects;
  } finally {
    database.close();
  }
}

/** The run's retained status, as a second connection sees it. */
function committedStatus(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT status FROM workflow_run WHERE id = 1").get();
    return String(row?.["status"]);
  } finally {
    database.close();
  }
}

/** The current Workspace root, as a second connection sees it. */
function committedRoot(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT current_root_id AS root FROM workspace_state").get();
    return String(row?.["root"]);
  } finally {
    database.close();
  }
}

function exists(path: string): boolean {
  try {
    new DatabaseSync(path, { readOnly: true }).close();
    return true;
  } catch {
    return false;
  }
}

describe("Tier WFX — a killed workflow run resumes from its frontier", () => {
  it("WFX1: SIGKILL mid-run, then resume: every effect exactly once", function* () {
    yield* useFixture(function* (fixture) {
      const path = workflowRunPath(fixture.runs, RUN_ID);

      const killed = yield* scoped(function* () {
        const cli = cliCommand(["workflow", "start", `--id=${RUN_ID}`, "flows/many.md"]);
        const child = yield* exec(cli.command, {
          arguments: cli.arguments,
          cwd: fixture.repository,
          env: {
            ...inherited(),
            HOME: fixture.home,
            XMD_WORKFLOW_RUNS: fixture.runs,
          },
        });
        // Read the child's streams so a full pipe cannot stall it before it has
        // committed anything.
        yield* spawn(function* () {
          const subscription = yield* child.stdout;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
        });
        yield* spawn(function* () {
          const subscription = yield* child.stderr;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
        });

        // The condition is what the database has published, never a sleep.
        yield* when(
          function* () {
            expect(exists(path)).toBe(true);
            expect(committedEffects(path).length).toBeGreaterThanOrEqual(3);
          },
          { timeout: 60_000 },
        );
        const before = committedEffects(path);
        const rootBefore = committedRoot(path);
        process.kill(child.pid, "SIGKILL");
        const status = yield* child.join();
        return { before, rootBefore, status };
      });

      expect(killed.status.signal).toBe("SIGKILL");
      expect(killed.before.length).toBeGreaterThanOrEqual(3);
      expect(killed.before.length).toBeLessThan(EFFECTS);

      // Nothing ran after the signal, so the run is still `running`: no status
      // was published and no execution record was closed.
      expect(committedStatus(path)).toBe("running");

      const resumed = yield* runCli(["workflow", "resume", RUN_ID], {
        cwd: fixture.repository,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        timeout: 180_000,
      }).join();

      expect(resumed.code).toBe(0);
      expect(resumed.stderr).toContain(`workflow run: ${RUN_ID}`);
      expect(resumed.stderr).toContain("workflow status: completed");
      expect(committedStatus(path)).toBe("completed");

      const after = committedEffects(path);

      // Every effect the kill left committed is still there, by its own event
      // id and in the same order: the resume replayed them rather than
      // performing them again.
      expect(after.slice(0, killed.before.length)).toEqual(killed.before);

      // And the whole history is exactly one effect per authored element — no
      // duplicate from an interrupted transaction that had already published,
      // and no gap from one that had not.
      expect(after).toHaveLength(EFFECTS);
      const targets = after.map((effect) => effect.name.split(":").at(-1));
      expect(new Set(targets).size).toBe(EFFECTS);
      expect(targets[0]).toBe("/out/f0.txt");
      expect(targets.at(-1)).toBe(`/out/f${EFFECTS - 1}.txt`);

      // The resume continued from the root the last committed effect left, so
      // the frontier moved on rather than starting again.
      expect(committedRoot(path)).not.toBe(killed.rootBefore);
    });
  });
});

/** What a child needs from this process, without a developer's own HOME. */
function inherited(): Record<string, string> {
  const names = ["PATH", "DENO_DIR", "DENO_INSTALL_ROOT", "XDG_CACHE_HOME", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return env;
}

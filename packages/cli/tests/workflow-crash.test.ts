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
import { all, ensure, scoped, spawn } from "effection";
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
import { readRunDatabase } from "./support/run-database.ts";

/** Enough effects that a kill lands part-way through rather than after. */
const EFFECTS = 60;

/** How many effects precede the wait in the document that holds. */
const HELD_EFFECTS = 3;

/**
 * How long the holding document waits.
 *
 * Long enough for a second process to start, be refused, and be observed;
 * short enough that a resume, which performs the wait again, is not the
 * expensive part of the test.
 */
const HOLD_SECONDS = 30;

const RUN_ID = "crashed-run";

function definition(count: number): string {
  const lines = ["# Many effects", ""];
  for (let index = 0; index < count; index += 1) {
    lines.push(`<File path="out/f${index}.txt">effect ${index}</File>`, "");
  }
  return lines.join("\n");
}

/**
 * A document that commits a few effects and then waits.
 *
 * A signal is not delivered to a process; it is delivered to a process that is
 * in a position to notice one, and a runtime notices at its event loop. A
 * document made only of file effects is a long stretch of work that reaches the
 * event loop rarely, so a `SIGINT` aimed at it may be observed nowhere near
 * where it was sent — the interruption is real but its timing is not the test's
 * to claim. This document has a place where the run is unambiguously waiting,
 * and everything about interruption is asserted there.
 *
 * Its shape also makes the wait *observable from outside*: the effects before it
 * are all the effects there are, so a second connection that can see every one
 * of them knows the run has reached the wait and has not left it.
 */
function holding(): string {
  const lines = ["# A run that waits", ""];
  for (let index = 0; index < HELD_EFFECTS; index += 1) {
    lines.push(`<File path="out/f${index}.txt">effect ${index}</File>`, "");
  }
  lines.push("```bash exec", `sleep ${HOLD_SECONDS}`, "```", "");
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
    yield* writeTextFile(join(fixture.repository, "flows/many.md"), definition(EFFECTS));
    yield* writeTextFile(join(fixture.repository, "flows/holding.md"), holding());

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wfx@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFX"]);
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
  return readRunDatabase(path, (database) => {
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
  });
}

/** The run's retained status, as a second connection sees it. */
function committedStatus(path: string): string {
  return readRunDatabase(path, (database) => {
    const row = database.prepare("SELECT status FROM workflow_run WHERE id = 1").get();
    return String(row?.["status"]);
  });
}

/** The current Workspace root, as a second connection sees it. */
function committedRoot(path: string): string {
  return readRunDatabase(path, (database) => {
    const row = database.prepare("SELECT current_root_id AS root FROM workspace_state").get();
    return String(row?.["root"]);
  });
}

interface ExecutionRow {
  readonly executionId: string;
  readonly stopped: boolean;
  readonly stopStatus: string | undefined;
  readonly stopReasonCode: string | undefined;
}

/**
 * Every execution the run retains, oldest first, as a second connection sees it.
 *
 * An execution row is how a host says "somebody was advancing this run", and
 * closing one is how the next owner says what became of that attempt. Reading
 * them by identity is what separates "an execution was closed" from "*this*
 * execution was closed".
 */
function committedExecutions(path: string): ExecutionRow[] {
  return readRunDatabase(path, (database) =>
    database
      .prepare(
        "SELECT execution_id AS id, stopped_at AS stopped, stop_status AS status, " +
          "stop_reason_code AS reason FROM document_executions ORDER BY sequence",
      )
      .all()
      .map((row) => ({
        executionId: String(row["id"]),
        stopped: row["stopped"] !== null,
        stopStatus: row["status"] === null ? undefined : String(row["status"]),
        stopReasonCode: row["reason"] === null ? undefined : String(row["reason"]),
      })),
  );
}

function exists(path: string): boolean {
  try {
    new DatabaseSync(path, { readOnly: true }).close();
    return true;
  } catch {
    return false;
  }
}

interface Signalled {
  readonly before: FileEffect[];
  readonly rootBefore: string;
  readonly status: { readonly code?: number; readonly signal?: string | null };
  readonly stderr: string;
}

/**
 * Start the run in a real child, wait until it has reached a stated point,
 * signal it, and report what it left.
 *
 * The wait is on what the database has published rather than on a sleep, so the
 * signal always lands on a process that has begun and has not finished. What
 * happens after the signal is the child's business and differs by signal, which
 * is the whole subject of this tier: `SIGKILL` runs nothing, and `SIGINT` runs
 * the interruption the host installed.
 */
function signalledRun(
  fixture: Fixture,
  signal: "SIGKILL" | "SIGINT",
  options: {
    readonly document?: string;
    readonly reached?: number;
    readonly awaited?: string;
  } = {},
): Operation<Signalled> {
  const { document = "flows/many.md", reached = 3, awaited } = options;
  return scoped(function* () {
    const path = workflowRunPath(fixture.runs, RUN_ID);
    const cli = cliCommand(["workflow", "start", `--id=${RUN_ID}`, document]);
    const child = yield* exec(cli.command, {
      arguments: cli.arguments,
      cwd: fixture.repository,
      env: {
        ...inherited(),
        HOME: fixture.home,
        XMD_WORKFLOW_RUNS: fixture.runs,
      },
    });

    const decoder = new TextDecoder();
    let stderr = "";
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
        stderr += decoder.decode(next.value, { stream: true });
        next = yield* subscription.next();
      }
    });

    // The condition is what the database has published, never a sleep.
    yield* when(
      function* () {
        expect(exists(path)).toBe(true);
        expect(committedEffects(path).length).toBeGreaterThanOrEqual(reached);
      },
      { timeout: 60_000 },
    );
    const before = committedEffects(path);
    const rootBefore = committedRoot(path);
    process.kill(child.pid, signal);
    const status = yield* child.join();

    // A pipe can still be holding what the child wrote on its way out, so what
    // it said is waited for as a condition rather than assumed to have arrived
    // with the exit status.
    if (awaited !== undefined) {
      yield* when(
        function* () {
          expect(stderr).toContain(awaited);
        },
        { timeout: 30_000 },
      );
    }
    return { before, rootBefore, status, stderr };
  });
}

describe("Tier WFX — a killed workflow run resumes from its frontier", () => {
  it("WFX1: SIGKILL mid-run, then resume: every effect exactly once", function* () {
    yield* useFixture(function* (fixture) {
      const path = workflowRunPath(fixture.runs, RUN_ID);

      const killed = yield* signalledRun(fixture, "SIGKILL");

      expect(killed.status.signal).toBe("SIGKILL");
      expect(killed.before.length).toBeGreaterThanOrEqual(3);
      expect(killed.before.length).toBeLessThan(EFFECTS);

      // Nothing ran after the signal, so the run is still `running`: no status
      // was published and no execution record was closed.
      expect(committedStatus(path)).toBe("running");

      // The killed owner's execution, by its own identity. It is open, because
      // closing one is work and the signal left no opportunity to do any.
      const abandoned = committedExecutions(path);
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]?.stopped).toBe(false);
      const owner = abandoned[0]?.executionId;

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

      // And the killed owner's own execution — that exact one, not merely some
      // execution — was closed as interrupted, saying what became of the attempt
      // the signal ended. The resume's execution is a different one, and it
      // completed.
      const settled = committedExecutions(path);
      expect(settled).toHaveLength(2);
      expect(settled[0]?.executionId).toBe(owner);
      expect(settled[0]?.stopped).toBe(true);
      expect(settled[0]?.stopStatus).toBe("interrupted");
      expect(settled[0]?.stopReasonCode).toBe("executor-interrupted");
      expect(settled[1]?.executionId).not.toBe(owner);
      expect(settled[1]?.stopStatus).toBe("completed");
    });
  });

  it("WFX2: Ctrl-C settles the run itself, releases it, and resumes clean", function* () {
    yield* useFixture(function* (fixture) {
      const path = workflowRunPath(fixture.runs, RUN_ID);

      // Signalled where the run is waiting, so the interruption is observed
      // where it was sent rather than wherever the runtime next looked.
      const interrupted = yield* signalledRun(fixture, "SIGINT", {
        document: "flows/holding.md",
        reached: HELD_EFFECTS,
        awaited: "workflow status: interrupted",
      });

      // A signalled process that reports its own interruption *exited*; it was
      // not killed by the signal. 130 is what an interrupted process exits with.
      expect(interrupted.status.signal ?? null).toBeNull();
      expect(interrupted.status.code).toBe(130);
      expect(interrupted.stderr).toContain("workflow status: interrupted");

      // This is the whole difference from WFX1, and it is visible before
      // anything resumes: the process that was interrupted settled its own run.
      // A kill leaves `running` with an open execution for the next owner to
      // reconcile; a Ctrl-C leaves the outcome already published.
      expect(committedStatus(path)).toBe("interrupted");
      const closed = committedExecutions(path);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.stopped).toBe(true);
      expect(closed[0]?.stopStatus).toBe("interrupted");
      expect(closed[0]?.stopReasonCode).toBe("executor-interrupted");
      const owner = closed[0]?.executionId;

      // The interrupted process released the run's lock on its way out. That is
      // what this resume proves by succeeding: acquisition is non-blocking and
      // refuses outright while an owner holds the lock, so a resume that gets as
      // far as running at all is a resume that found the run unowned.
      const resumed = yield* runCli(["workflow", "resume", RUN_ID], {
        cwd: fixture.repository,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        timeout: 180_000,
      }).join();

      expect(resumed.code).toBe(0);
      expect(resumed.stderr).toContain("workflow status: completed");
      expect(committedStatus(path)).toBe("completed");

      // Nothing the interruption had already committed was performed again, by
      // event id and in order, and the document's effects appear exactly once.
      const after = committedEffects(path);
      expect(after.slice(0, interrupted.before.length)).toEqual(interrupted.before);
      expect(after).toHaveLength(HELD_EFFECTS);
      expect(new Set(after.map((effect) => effect.name)).size).toBe(HELD_EFFECTS);

      // The interrupted execution stays closed as it was, and the resume's is a
      // second, different one.
      const settled = committedExecutions(path);
      expect(settled).toHaveLength(2);
      expect(settled[0]?.executionId).toBe(owner);
      expect(settled[0]?.stopStatus).toBe("interrupted");
      expect(settled[1]?.executionId).not.toBe(owner);
      expect(settled[1]?.stopStatus).toBe("completed");
    });
  });

  it("WFX3: two processes race one resumable run; exactly one advances it", function* () {
    yield* useFixture(function* (fixture) {
      const path = workflowRunPath(fixture.runs, RUN_ID);

      // A killed run is the interesting starting point: it is resumable, it has
      // an open execution somebody must reconcile, and its lock is free. Both
      // racers are entitled to it and only one may have it.
      yield* signalledRun(fixture, "SIGKILL", {
        document: "flows/holding.md",
        reached: HELD_EFFECTS,
      });
      expect(committedStatus(path)).toBe("running");
      expect(committedExecutions(path)).toHaveLength(1);

      const options = {
        cwd: fixture.repository,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        timeout: 180_000,
      };
      // Launched together, not one after the other. Which process wins the lock
      // is genuinely undecided — that is what makes this a race — but how many
      // win is not, and neither is what the loser is allowed to have done. The
      // document holds the winner at its wait for long enough that the loser
      // cannot mistake a finished run for a free one.
      const [first, second] = yield* all([
        runCli(["workflow", "resume", RUN_ID], options).join(),
        runCli(["workflow", "resume", RUN_ID], options).join(),
      ]);

      const winners = [first, second].filter((result) => result.code === 0);
      const losers = [first, second].filter((result) => result.code !== 0);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      expect(winners[0]?.stderr).toContain("workflow status: completed");
      expect(losers[0]?.code).toBe(1);
      expect(losers[0]?.stderr).toContain(`workflow run ${RUN_ID} is already running`);

      // The loser was refused before it could begin anything: the run holds the
      // killed owner's execution and the winner's, and no third. A refusal that
      // still recorded an execution would be a second owner advancing the run.
      const settled = committedExecutions(path);
      expect(settled).toHaveLength(2);
      expect(settled[0]?.stopStatus).toBe("interrupted");
      expect(settled[1]?.stopStatus).toBe("completed");

      // And one winner means one set of effects.
      expect(committedStatus(path)).toBe("completed");
      const after = committedEffects(path);
      expect(after).toHaveLength(HELD_EFFECTS);
      expect(new Set(after.map((effect) => effect.name)).size).toBe(HELD_EFFECTS);
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

/**
 * Tier WRH12 — what a completed run reaches when it is asked to run again.
 *
 * The rule is easy to state and easy to get wrong in one direction: a completed
 * replay may read the run's own storage, because that is where the result is,
 * and may reach nothing else. So this drives `runWorkflow()` — the same
 * orchestration the shared CLI drives — with canonical core underneath it, and
 * makes every other boundary fail if it is entered: the Git capability throws
 * on every question, and the host's `attach()` throws when it is called at all.
 *
 * A completed replay under those conditions is not "a run that happened to
 * work". It is a run that could not have consulted a checkout, could not have
 * opened a Workspace, and produced the retained bytes anyway.
 *
 * The local Deno host is the oracle here rather than the subject. What the
 * remote owner does with the same reads is proved against a real Durable Object
 * in `packages/workflow/tests/cloudflare/remote-replay.vitest.ts`; what the
 * shared decision does with retained values is proved over values in
 * `packages/workflow/tests/replay-inputs.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, ensure, Err, Ok, resource, scoped } from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp } from "node:fs/promises";
import { until } from "effection";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { Json } from "@executablemd/core";
import type { DurableEvent } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import {
  useWorkflowInputDelivery,
  useWorkflowLifecycle,
  useWorkflowRunHost,
  withWorkflowWorkspace,
  workflowRunPath,
} from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions } from "@executablemd/workflow";
import { forkRunRecordEvent, Git, WorkflowLifecycle } from "@executablemd/workflow";
import type {
  WorkflowDefinition,
  WorkflowHistoryEntry,
  WorkflowRunDatabase,
  WorkflowRunStatus,
} from "@executablemd/workflow";
import { establishDefinition } from "../src/workflow-definition.ts";
import { runWorkflow } from "../src/workflow.ts";
import { runWorkflowManagement } from "../src/workflow-management.ts";
import type {
  WorkflowExecution,
  WorkflowHost,
  WorkflowRequest,
  WorkflowStart,
} from "../src/workflow.ts";

const REQUEST: WorkflowRequest = {
  action: "start",
  target: "workflow.md",
  id: undefined,
  verbose: false,
  raw: false,
  secretDetection: false,
};

const CHECKPOINT_SCHEMA =
  '{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}';

/** A document with no wait and no effect: the smallest completed run. */
const PLAIN = "# Retained\n\nthe run recorded this line.\n";

/** A document that fails after the root import, so its terminal carries an error. */
const FAILING = "# Retained\n\npartial line.\n\n<Missing />\n";

/** A document that waits, so a run can be observed while it has not ended. */
const WAITING = [
  "# Retained",
  "",
  "before the wait.",
  "",
  `<Elicit schema={${CHECKPOINT_SCHEMA}} as="decision">`,
  "Proceed with the change?",
  "</Elicit>",
  "",
  "decision: {decision.proceed}",
  "",
].join("\n");

/** The same wait, inside a root closed over a component it must reconstruct. */
const BUNDLED_WAITING = [
  "---",
  "workflow:",
  "  components:",
  "    Stage: ./Stage.md",
  "---",
  "",
  "# Retained",
  "",
  "<Stage />",
  "",
  `<Elicit schema={${CHECKPOINT_SCHEMA}} as="decision">`,
  "Proceed with the change?",
  "</Elicit>",
  "",
  "decision: {decision.proceed}",
  "",
].join("\n");

/** A root closed over two components, one of which it never invokes. */
const BUNDLED = [
  "---",
  "workflow:",
  "  components:",
  "    Stage: ./Stage.md",
  "    Unused: ./Unused.md",
  "---",
  "",
  "# Retained",
  "",
  "<Stage />",
  "",
].join("\n");

interface Fixture {
  readonly repository: string;
  readonly runs: string;
}

function* git(repository: string, args: string[]): Operation<string> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** One committed definition and one empty run store, both this case's own. */
function useFixture(source: string, components: Record<string, string> = {}): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const repository = yield* until(mkdtemp(join(tmpdir(), "xmd-wrp-repo-")));
    const runs = yield* until(mkdtemp(join(tmpdir(), "xmd-wrp-runs-")));
    yield* ensure(function* () {
      yield* rm(repository, { recursive: true, force: true });
      yield* rm(runs, { recursive: true, force: true });
    });
    yield* git(repository, ["init", "--quiet"]);
    yield* git(repository, ["config", "user.email", "wrp@example.test"]);
    yield* git(repository, ["config", "user.name", "WRP"]);
    yield* writeTextFile(join(repository, "workflow.md"), source);
    yield* git(repository, ["add", "workflow.md"]);
    for (const [name, content] of Object.entries(components)) {
      yield* writeTextFile(join(repository, `${name}.md`), content);
      yield* git(repository, ["add", `${name}.md`]);
    }
    yield* git(repository, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "definition"]);
    yield* provide({ repository, runs });
  });
}

/** The Git capability, answered from the fixture repository itself. */
function useRepositoryGit(repository: string): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *repositoryRoot(): Operation<string> {
        return repository;
      },
      *revParse([revision]): Operation<string> {
        return (yield* git(repository, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          revision,
        ])).trim();
      },
      *readObject([commit, path]): Operation<string> {
        return yield* git(repository, ["cat-file", "blob", `${commit}:${path}`]);
      },
      // deno-lint-ignore require-yield
      *objectFormat(): Operation<"sha1" | "sha256"> {
        return "sha1";
      },
    },
    { at: "min" },
  );
}

/**
 * A Git capability that answers nothing and records being asked.
 *
 * The point of the recording is that the assertion can be about the question
 * rather than about the answer: a replay that reached here would be refused,
 * and `asked` says which question it reached with.
 */
function useRefusingGit(asked: string[]): Operation<void> {
  const refuse = (question: string): never => {
    asked.push(question);
    throw new Error(`PLANTED-GIT-REACHED: ${question}`);
  };
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *repositoryRoot(): Operation<string> {
        return refuse("repositoryRoot");
      },
      // deno-lint-ignore require-yield
      *revParse(): Operation<string> {
        return refuse("revParse");
      },
      // deno-lint-ignore require-yield
      *readObject(): Operation<string> {
        return refuse("readObject");
      },
      // deno-lint-ignore require-yield
      *objectFormat(): Operation<"sha1" | "sha256"> {
        return refuse("objectFormat");
      },
    },
    { at: "min" },
  );
}

/** The production local host, recording each attachment it opens. */
function liveHost(runs: string, attached: string[]): WorkflowHost {
  return {
    useRunHost(): Operation<WorkflowExecutionTransitions> {
      return useWorkflowRunHost({ root: runs });
    },
    useLifecycle(): Operation<void> {
      return useWorkflowLifecycle({ root: runs });
    },
    useDelivery(): Operation<void> {
      return useWorkflowInputDelivery({ root: runs });
    },
    attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      attached.push(database.record.runId);
      return withWorkflowWorkspace(database, operation);
    },
  };
}

/** The same host, with the one boundary a completed replay must never enter. */
function replayHost(runs: string, attached: string[]): WorkflowHost {
  const live = liveHost(runs, attached);
  return {
    useRunHost: live.useRunHost,
    useLifecycle: live.useLifecycle,
    useDelivery: live.useDelivery,
    attach<T>(): Operation<T> {
      attached.push("attach");
      throw new Error("PLANTED-ATTACHMENT-REACHED");
    },
  };
}

interface Invocation {
  readonly exitCode: number;
  readonly out: string[];
  readonly err: string[];
}

/** One `runWorkflow()` invocation, with what it reported on each stream. */
function invoke(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  host: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<Invocation> {
  return scoped(function* () {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    yield* ensure(() => {
      console.log = log;
      console.error = error;
    });
    console.log = (...parts: unknown[]) => out.push(parts.map((part) => String(part)).join(" "));
    console.error = (...parts: unknown[]) => err.push(parts.map((part) => String(part)).join(" "));
    const outcome = yield* runWorkflow(request, start, host, execute);
    return { exitCode: outcome.exitCode, out, err };
  });
}

/** What one document execution was given, what it rendered, and how it ended. */
interface Rendered {
  root: unknown;
  /** Whether any installation offered an execution view to import from. */
  imports: boolean;
  output: string;
  result: Result<Json> | undefined;
}

/** The pinned document, executed as this run's root through canonical core. */
function pinnedBody(seen: Rendered[]): (execution: WorkflowExecution) => Operation<Result<void>> {
  return function* (execution): Operation<Result<void>> {
    return yield* execution.around(
      call(function* (): Operation<Result<void>> {
        const running = yield* executeInstalled(
          { ...execution.root, stream: execution.stream, props: execution.props },
          execution.installations,
        );
        // The close value of the output stream is the complete or partial
        // rendered text, so a failed execution still reports what it rendered.
        const subscription = yield* running.output;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
        const result = yield* running;
        seen.push({
          root: { ...execution.root },
          imports: execution.installations.some(
            (installation) => installation.bundle !== undefined,
          ),
          output: next.value,
          result,
        });
        return result.ok ? Ok(undefined) : Err(new Error(String(result.error.message)));
      }),
    );
  };
}

/** What `xmd workflow start` establishes, through the command's own module. */
function* startFor(fixture: Fixture): Operation<WorkflowStart> {
  const established = yield* establishDefinition(join(fixture.repository, "workflow.md"));
  if (!established.ok) {
    throw established.error;
  }
  return { established: established.value, props: {}, propsSchema: {} };
}

/** The run id one invocation reported, or the empty string when it reported none. */
function runIdOf(invocation: Invocation): string {
  const line = invocation.err.find((entry) => entry.startsWith("workflow run: "));
  return line === undefined ? "" : line.slice("workflow run: ".length).trim();
}

/** What one invocation published as this run's status, if anything. */
function statusOf(invocation: Invocation): string | undefined {
  const line = invocation.err.find((entry) => entry.startsWith("workflow status: "));
  return line === undefined ? undefined : line.slice("workflow status: ".length).trim();
}

/** Everything about a run a replay must not move, read through the host itself. */
interface Retained {
  readonly status: WorkflowRunStatus;
  readonly stopReason: string;
  /**
   * Which rule chose the reason, in terms two different runs can be compared
   * by: a journal reason names a row, and a row's identity is its own run's.
   */
  readonly reasonAt: string;
  readonly updatedAt: string;
  readonly executions: number;
  /** What each execution ended as, in order. `null` is one still open. */
  readonly ended: (WorkflowRunStatus | null)[];
  readonly currentWorkspaceRootId: string;
  readonly journal: string;
}

function* retained(runs: string, runId: string): Operation<Retained> {
  return yield* scoped(function* () {
    yield* useWorkflowLifecycle({ root: runs });
    const snapshot = yield* WorkflowLifecycle.operations.inspect(runId);
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    const history = yield* WorkflowLifecycle.operations.history(runId);
    if (!history.ok) {
      throw history.error;
    }
    const stopReason = snapshot.value.record.stopReason;
    const at =
      stopReason === undefined
        ? "none"
        : stopReason.kind === "host"
          ? `host:${stopReason.code}`
          : `journal:${history.value.findIndex((entry) => entry.eventId === stopReason.eventId)}`;
    return {
      status: snapshot.value.record.status,
      stopReason: JSON.stringify(stopReason ?? null),
      reasonAt: at,
      updatedAt: snapshot.value.record.updatedAt,
      executions: snapshot.value.executions.length,
      ended: snapshot.value.executions.map((execution) => execution.stopStatus ?? null),
      currentWorkspaceRootId: snapshot.value.currentWorkspaceRootId,
      // Identity and content of every retained row, in order: a length would
      // not notice one rewritten under a new id.
      journal: JSON.stringify(
        history.value.map((entry: WorkflowHistoryEntry) => [
          entry.eventId,
          entry.workspaceRootId,
          entry.event,
        ]),
      ),
    };
  });
}

/** The retained answers this run holds, read the way something outside XMD would. */
function answers(runs: string, runId: string): { suspensionId: string; state: string }[] {
  const database = new DatabaseSync(workflowRunPath(runs, runId), { readOnly: true });
  try {
    return database
      .prepare("SELECT suspension_id, state FROM workflow_suspension_answers ORDER BY rowid")
      .all()
      .map((row) => ({
        suspensionId: String(row["suspension_id"]),
        state: String(row["state"]),
      }));
  } finally {
    database.close();
  }
}

/** How many `suspension_answer` events this run's history holds. */
function* acceptedAnswers(runs: string, runId: string): Operation<number> {
  return yield* scoped(function* () {
    yield* useWorkflowLifecycle({ root: runs });
    const history = yield* WorkflowLifecycle.operations.history(runId);
    if (!history.ok) {
      throw history.error;
    }
    return history.value.filter(
      (entry) =>
        entry.event.type === "yield" && entry.event.description.type === "suspension_answer",
    ).length;
  });
}

describe("what a completed run reaches when it is asked to run again", () => {
  it("WRP1: replays the retained result with no repository and no Workspace", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const live: Rendered[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(PLAIN);
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody(live),
        );
      });
      expect(started.exitCode).toBe(0);
      const runId = runIdOf(started);
      const before = yield* retained(fixture.runs, runId);

      // From here the repository answers nothing and the host attaches
      // nothing. Either one being reached is a planted failure.
      const resumed = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return { started, resumed, before, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.resumed.exitCode).toBe(0);
    expect(statusOf(outcome.resumed)).toBe("completed");
    // Nothing was asked of the repository, and the only attachment is the live
    // run's own.
    expect(asked).toEqual([]);
    expect(attached).toHaveLength(1);

    // The document canonical execution was handed is the one the run recorded,
    // reported by the path its definition names. Not a placeholder, not the
    // working tree, and not an empty source.
    expect(replayed[0]?.root).toEqual({ path: "workflow.md", source: PLAIN, retained: true });
    expect(replayed[0]?.root).toEqual(live[0]?.root);

    // Byte for byte, and the same result.
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.output).toBe(live[0]?.output);
    expect(replayed[0]?.result?.ok).toBe(true);
    expect(replayed[0]?.result?.ok === true && replayed[0]?.result.value).toEqual(
      live[0]?.result?.ok === true ? live[0]?.result.value : undefined,
    );

    // The run is exactly where it was, apart from the one execution envelope
    // the lifecycle records for the invocation that replayed it. A replay
    // observes an outcome that already won, so it republishes nothing — not the
    // status, not the reason, and not when the run last moved.
    expect(outcome.after.status).toBe("completed");
    expect(outcome.after.stopReason).toBe(outcome.before.stopReason);
    expect(outcome.after.updatedAt).toBe(outcome.before.updatedAt);
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
    expect(outcome.after.executions).toBe(outcome.before.executions + 1);
  });

  it("WRP2: recovers a stale failure to itself, refuses resume, and replays it", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const live: Rendered[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(FAILING);

      // The document fails and its settlement never lands, so the run is left
      // holding a result nothing published. Recovery reads the same result the
      // settlement would have, and publishes the same outcome.
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          refusingSettlement(fixture.runs),
          pinnedBody(live),
        );
      });
      const runId = runIdOf(started);
      expect(runId).not.toBe("");
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("running");

      // What an uninterrupted settlement would have published, for comparison
      // with what recovery does.
      const uninterrupted = yield* scoped(function* () {
        const fixtureTwo = yield* useFixture(FAILING);
        const settled = yield* scoped(function* () {
          yield* useRepositoryGit(fixtureTwo.repository);
          return yield* invoke(
            { ...REQUEST, id: "settled-1" },
            yield* startFor(fixtureTwo),
            liveHost(fixtureTwo.runs, []),
            pinnedBody([]),
          );
        });
        expect(settled.exitCode).toBe(1);
        const state = yield* retained(fixtureTwo.runs, "settled-1");
        return { status: state.status, reason: state.reasonAt };
      });

      // A resume is what the settled lifecycle refuses for a failed run.
      const refused = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      const recovered = yield* retained(fixture.runs, runId);

      // The same run, named again by a compatible start, replays that failure.
      const candidate = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });
      const again = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          candidate,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return {
        refused,
        again,
        before,
        recovered,
        uninterrupted,
        after: yield* retained(fixture.runs, runId),
      };
    });

    // Recovery published exactly what an uninterrupted settlement publishes —
    // one semantic outcome, reached two ways.
    expect(outcome.recovered.status).toBe(outcome.uninterrupted.status);
    expect(outcome.recovered.status).toBe("failed");
    expect(outcome.recovered.reasonAt).toBe(outcome.uninterrupted.reason);
    expect(outcome.recovered.journal).toBe(outcome.before.journal);
    // The resume is refused by the settled failed-run rule, without a replay
    // envelope of its own.
    expect(outcome.refused.exitCode).toBe(1);
    expect(outcome.refused.err.join(" ")).toContain("workflow run failed");
    expect(outcome.recovered.executions).toBe(outcome.before.executions);
    expect(statusOf(outcome.refused)).toBeUndefined();

    // The compatible start replays the same failure and the partial output it
    // had rendered, reaching no repository and no Workspace.
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.result?.ok).toBe(false);
    expect(replayed[0]?.output).toBe(live[0]?.output);
    expect(replayed[0]?.output).toContain("partial line.");
    expect(outcome.again.exitCode).toBe(1);
    expect(asked).toEqual([]);
    expect(attached).toEqual([]);
    // And the retained failure is the one that stands, byte for byte.
    expect(outcome.after.status).toBe("failed");
    expect(outcome.after.stopReason).toBe(outcome.recovered.stopReason);
    expect(outcome.after.updatedAt).toBe(outcome.recovered.updatedAt);
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
    expect(outcome.after.executions).toBe(outcome.recovered.executions + 1);
  });

  it("WRP3: replays a bundled run without reading one component", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const live: Rendered[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        // Declared, committed, and never invoked by the root. A replay may not
        // fetch it, and its absence from the history is not a refusal.
        Unused: "never imported.\n",
      });
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody(live),
        );
      });
      expect(started.exitCode).toBe(0);
      const runId = runIdOf(started);
      const before = yield* retained(fixture.runs, runId);

      const resumed = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return { resumed, before, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.resumed.exitCode).toBe(0);
    expect(statusOf(outcome.resumed)).toBe("completed");
    expect(asked).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(replayed[0]?.root).toEqual({ path: "workflow.md", source: BUNDLED, retained: true });
    expect(replayed[0]?.output).toBe(live[0]?.output);
    expect(replayed[0]?.output).toContain("staged.");
    expect(replayed[0]?.output).not.toContain("never imported.");
    expect(outcome.after.journal).toBe(outcome.before.journal);
  });

  it("WRP4: refuses retained state that describes no completed run", function* () {
    const asked: string[] = [];
    const attached: string[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(PLAIN);
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      const runId = runIdOf(started);

      // A lifecycle row that says the run ended, over a history that records no
      // result: the two cannot both be right, and neither is a replay.
      yield* emptyJournal(fixture.runs, runId);
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("completed");

      const refused = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      return { refused, before, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.refused.exitCode).toBe(1);
    // Refused before an attachment, a native operation or a definition read.
    expect(asked).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(outcome.refused.err.join(" ")).toContain("records no document result");
    // No status was published for a run whose status did not change, and the
    // journal and Workspace frontier are exactly what they were.
    expect(statusOf(outcome.refused)).toBeUndefined();
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.status).toBe("completed");
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
  });

  it("WRP8: recovers a bundled run whose result committed and whose settlement did not", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const live: Rendered[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        Unused: "never imported.\n",
      });

      // The executor committed the document's result and then went without
      // settling. This is the supported crash window, not damaged input: the
      // run reads `running`, and its journal already holds the outcome.
      const crashed = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          refusingSettlement(fixture.runs, attached),
          pinnedBody(live),
        );
      });
      expect(crashed.exitCode).toBe(1);
      const runId = runIdOf(crashed);
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("running");

      // No checkout, no Workspace. Before the correction this reached Git for
      // the bundle, because the status the run still carried was `running`.
      const resumed = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return { resumed, before, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.resumed.exitCode).toBe(0);
    expect(statusOf(outcome.resumed)).toBe("completed");
    // The lifecycle recovered it; nothing was asked of the repository and
    // nothing was attached.
    expect(asked).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(replayed[0]?.output).toBe(live[0]?.output);
    expect(replayed[0]?.output).toContain("staged.");
    expect(replayed[0]?.result?.ok).toBe(true);

    // The frontier is untouched, the stale envelope was closed by the settled
    // recovery, and the run is the completed run its history says it is.
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
    expect(outcome.after.ended).toEqual(["completed", "completed"]);
    expect(outcome.after.status).toBe("completed");
  });

  it("WRP9: recovers a bundled run whose committed result is a failure", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const live: Rendered[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n\n<Missing />\n",
        Unused: "never imported.\n",
      });
      const crashed = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          refusingSettlement(fixture.runs, attached),
          pinnedBody(live),
        );
      });
      expect(crashed.exitCode).toBe(1);
      const runId = runIdOf(crashed);
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("running");
      expect(live[0]?.result?.ok).toBe(false);

      // Recovery reads the document's own result, so a run whose document
      // failed recovers as failed — and the settled rule then refuses a resume.
      const refused = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      const recovered = yield* retained(fixture.runs, runId);

      const candidate = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });
      const again = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          candidate,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return { refused, again, before, recovered, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.recovered.status).toBe("failed");
    expect(outcome.recovered.journal).toBe(outcome.before.journal);
    expect(outcome.refused.exitCode).toBe(1);
    expect(outcome.refused.err.join(" ")).toContain("workflow run failed");
    expect(outcome.recovered.executions).toBe(outcome.before.executions);

    // The same failure, replayed rather than retried, with the output it had
    // rendered before it failed.
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.result?.ok).toBe(false);
    expect(replayed[0]?.output).toBe(live[0]?.output);
    expect(outcome.again.exitCode).toBe(1);
    expect(asked).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(outcome.after.status).toBe("failed");
    expect(outcome.after.stopReason).toBe(outcome.recovered.stopReason);
    expect(outcome.after.updatedAt).toBe(outcome.recovered.updatedAt);
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
  });

  it("WRP10: recovers a bundled run whose retained result is a failed terminal", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    let executed = 0;

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        Unused: "never imported.\n",
      });
      const established = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });

      // A root coroutine that ended by raising rather than by producing a
      // document result. `rootOutcome()` reads that as the run having failed,
      // and names the exact row as its reason.
      const runId = yield* seedStaleRun(fixture, established, raisedHistory(established));
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("running");

      const resumed = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          // deno-lint-ignore require-yield
          function* (): Operation<Result<void>> {
            executed += 1;
            return Ok(undefined);
          },
        );
      });
      return { resumed, before, after: yield* retained(fixture.runs, runId) };
    });

    // The lifecycle recovered the canonical failed outcome and then applied the
    // settled refusal: a run that failed is not resumed.
    expect(outcome.resumed.exitCode).toBe(1);
    expect(outcome.resumed.err.join(" ")).toContain("workflow run failed");
    expect(outcome.after.status).toBe("failed");
    expect(outcome.after.ended).toEqual(["failed"]);
    // And it got there without a repository, a Workspace or an execution.
    expect(asked).toEqual([]);
    expect(attached).toEqual([]);
    expect(executed).toBe(0);
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
  });

  it("WRP11: replays a completed run named again by a compatible start", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const live: Rendered[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        Unused: "never imported.\n",
      });
      const runId = "compatible-1";

      // Establishing the candidate is what proves the two runs are the same
      // run, and it reads the repository. It happens before the invocation, and
      // everything the invocation itself asks of Git is recorded separately.
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          { ...REQUEST, id: runId },
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody(live),
        );
      });
      expect(started.exitCode).toBe(0);
      expect(runIdOf(started)).toBe(runId);
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("completed");

      // The same definition and props, named at the same run. The candidate is
      // established under a repository that answers; the invocation runs under
      // one that refuses, so anything it asks for after admission is a planted
      // failure.
      const candidate = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });
      const again = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          candidate,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return { again, before, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.again.exitCode).toBe(0);
    expect(statusOf(outcome.again)).toBe("completed");
    // Nothing was asked of the repository after admission, and nothing was
    // attached: the candidate described the request, and the run's own history
    // supplied the result.
    expect(asked).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.root).toEqual({ path: "workflow.md", source: BUNDLED, retained: true });
    expect(replayed[0]?.output).toBe(live[0]?.output);
    expect(replayed[0]?.output).toContain("staged.");
    expect(replayed[0]?.result?.ok).toBe(true);
    // The live run was given a bundle to import from; the replay was not. It
    // resolves no name, so it is granted no authority to resolve one.
    expect(live[0]?.imports).toBe(true);
    expect(replayed[0]?.imports).toBe(false);

    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
    expect(outcome.after.status).toBe("completed");
    expect(outcome.after.stopReason).toBe(outcome.before.stopReason);
    expect(outcome.after.updatedAt).toBe(outcome.before.updatedAt);
    expect(outcome.after.executions).toBe(outcome.before.executions + 1);
  });

  it("WRP12: refuses a compatible start over a lifecycle row its result contradicts", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    let executed = 0;

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        Unused: "never imported.\n",
      });
      const established = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });

      // The root raised, and the row says the run completed. Two accounts of
      // one run, and a replay that reused either would be choosing between them.
      const runId = yield* seedStaleRun(fixture, established, raisedHistory(established), {
        status: "completed",
      });
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("completed");

      const refused = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          established,
          replayHost(fixture.runs, attached),
          // deno-lint-ignore require-yield
          function* (): Operation<Result<void>> {
            executed += 1;
            return Ok(undefined);
          },
        );
      });
      const stalled = yield* retained(fixture.runs, runId);

      // The next acquisition closes exactly the envelope the refusal left, and
      // publishes no replacement outcome for the run.
      yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          established,
          replayHost(fixture.runs, attached),
          // deno-lint-ignore require-yield
          function* (): Operation<Result<void>> {
            executed += 1;
            return Ok(undefined);
          },
        );
      });
      return { refused, before, stalled, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.refused.exitCode).toBe(1);
    expect(outcome.refused.err.join(" ")).toContain("describe different outcomes");
    // Refused before terminal reuse, before live support and before any
    // attachment: nothing executed and nothing was asked of the repository.
    expect(executed).toBe(0);
    expect(asked).toEqual([]);
    expect(attached).toEqual([]);
    expect(statusOf(outcome.refused)).toBeUndefined();

    // The one difference is the envelope begin had already inserted.
    expect(outcome.stalled.journal).toBe(outcome.before.journal);
    expect(outcome.stalled.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
    expect(outcome.stalled.status).toBe("completed");
    expect(outcome.stalled.stopReason).toBe(outcome.before.stopReason);
    expect(outcome.stalled.updatedAt).toBe(outcome.before.updatedAt);
    expect(outcome.stalled.executions).toBe(outcome.before.executions + 1);
    expect(outcome.stalled.ended.at(-1)).toBe(null);

    // And the settled terminal-replay recovery closes that envelope alone: the
    // next begin finishes it as interrupted, publishes no outcome for the run,
    // and refuses the same contradiction again.
    expect(outcome.after.ended).toEqual([...outcome.before.ended, "interrupted", null]);
    expect(outcome.after.status).toBe("completed");
    expect(outcome.after.stopReason).toBe(outcome.before.stopReason);
    expect(outcome.after.journal).toBe(outcome.before.journal);
  });

  it("WRP13: replays a coherent failed run named again by a compatible start", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        Unused: "never imported.\n",
      });
      const established = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });

      // A failed row naming the exact retained result it failed at.
      const runId = yield* seedStaleRun(fixture, established, raisedHistory(established), {
        status: "failed",
        reason: "root-close",
      });
      const before = yield* retained(fixture.runs, runId);
      expect(before.status).toBe("failed");

      const again = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          established,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return { again, before, after: yield* retained(fixture.runs, runId) };
    });

    // The same failure, replayed rather than retried.
    expect(outcome.again.exitCode).toBe(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.result?.ok).toBe(false);
    expect(outcome.again.err.join(" ")).toContain("the executor died");
    expect(asked).toEqual([]);
    expect(attached).toEqual([]);

    // And the retained failed outcome is the one that stands.
    expect(outcome.after.status).toBe("failed");
    expect(outcome.after.stopReason).toBe(outcome.before.stopReason);
    expect(outcome.after.updatedAt).toBe(outcome.before.updatedAt);
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
  });

  it("WRP14: refuses a start whose definition is not the run it names", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    let executed = 0;

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED, {
        Stage: "staged.\n",
        Unused: "never imported.\n",
      });
      const runId = "incompatible-1";
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          { ...REQUEST, id: runId },
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      expect(started.exitCode).toBe(0);
      const before = yield* retained(fixture.runs, runId);

      // One component says something else, and it is committed. The bundle is
      // definition identity, so this names a run of different code.
      yield* writeTextFile(join(fixture.repository, "Stage.md"), "staged differently.\n");
      yield* git(fixture.repository, ["add", "-A"]);
      yield* git(fixture.repository, [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "a component changed",
      ]);

      const candidate = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* startFor(fixture);
      });
      const refused = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, id: runId },
          candidate,
          replayHost(fixture.runs, attached),
          // deno-lint-ignore require-yield
          function* (): Operation<Result<void>> {
            executed += 1;
            return Ok(undefined);
          },
        );
      });
      return { refused, before, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.refused.exitCode).toBe(1);
    expect(outcome.refused.err.join(" ")).toContain("definition");
    expect(statusOf(outcome.refused)).toBeUndefined();
    // Refused inside the begin transaction, before a replay execution existed.
    expect(executed).toBe(0);
    expect(attached).toHaveLength(1);
    expect(outcome.after.executions).toBe(outcome.before.executions);
    expect(outcome.after.journal).toBe(outcome.before.journal);
    expect(outcome.after.status).toBe(outcome.before.status);
  });

  it("WRP5: a run that has not ended still reconstructs, and its refusal is cleaned up", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const rendered: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(BUNDLED_WAITING, { Stage: "staged.\n" });
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      expect(started.exitCode).toBe(2);
      const runId = runIdOf(started);
      expect(statusOf(started)).toBe("suspended");
      const before = yield* retained(fixture.runs, runId);

      // The same repository refusal a completed replay is indifferent to. A
      // suspended run is not: it continues by importing, so it reads the
      // definition and refuses whole when it cannot.
      const refused = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      const stalled = yield* retained(fixture.runs, runId);

      // The cleanup is the settled one, and it is the next acquisition's: it
      // closes exactly the envelope that refused and continues the run into
      // the wait it was standing at.
      const again = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          liveHost(fixture.runs, attached),
          pinnedBody(rendered),
        );
      });
      return { refused, again, before, stalled, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.refused.exitCode).toBe(1);
    // The repository was asked, which is the whole distinction.
    expect(asked.length).toBeGreaterThan(0);
    // Nothing was published for a run this invocation could not advance.
    expect(statusOf(outcome.refused)).toBeUndefined();

    // The lifecycle decided first, so the envelope exists. What it may not
    // touch is the frontier: the journal and the Workspace root the run stands
    // on are exactly what they were.
    expect(outcome.stalled.journal).toBe(outcome.before.journal);
    expect(outcome.stalled.currentWorkspaceRootId).toBe(outcome.before.currentWorkspaceRootId);
    expect(outcome.stalled.executions).toBe(outcome.before.executions + 1);
    expect(outcome.stalled.ended.at(-1)).toBe(null);

    // And the settled recovery closes exactly that envelope as interrupted,
    // without inventing an outcome for the run.
    expect(outcome.after.ended.slice(0, -1)).toEqual([...outcome.before.ended, "interrupted"]);
    expect(statusOf(outcome.again)).toBe("suspended");
    expect(outcome.after.status).toBe("suspended");
    expect(outcome.after.journal).toBe(outcome.before.journal);
    // Two attachments: the live start's and the recovered continuation's. The
    // refused invocation attached nothing.
    expect(attached).toHaveLength(2);
  });

  it("WRP6: replays a recorded answer without consuming or appending another", function* () {
    const asked: string[] = [];
    const attached: string[] = [];
    const replayed: Rendered[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(WAITING);
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      expect(started.exitCode).toBe(2);
      const runId = runIdOf(started);
      const suspensionId = String(
        started.err.find((line) => line.startsWith("workflow suspension: ")),
      )
        .slice("workflow suspension: ".length)
        .trim();

      const delivered = yield* scoped(function* () {
        const out: string[] = [];
        const log = console.log;
        yield* ensure(() => {
          console.log = log;
        });
        console.log = (...parts: unknown[]) => out.push(parts.map(String).join(" "));
        return yield* runWorkflowManagement(
          {
            action: "answer",
            runId,
            suspensionId,
            value: { proceed: true },
            secretDetection: true,
          },
          liveHost(fixture.runs, attached),
        );
      });
      expect(delivered.exitCode).toBe(0);

      const finished = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      expect(finished.exitCode).toBe(0);

      const before = yield* retained(fixture.runs, runId);
      const answersBefore = answers(fixture.runs, runId);
      const acceptedBefore = yield* acceptedAnswers(fixture.runs, runId);

      const replay = yield* scoped(function* () {
        yield* useRefusingGit(asked);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody(replayed),
        );
      });
      return {
        replay,
        before,
        answersBefore,
        acceptedBefore,
        after: yield* retained(fixture.runs, runId),
        answersAfter: answers(fixture.runs, runId),
        acceptedAfter: yield* acceptedAnswers(fixture.runs, runId),
      };
    });

    expect(outcome.replay.exitCode).toBe(0);
    expect(statusOf(outcome.replay)).toBe("completed");
    // The delivered value reached the document through the retained event.
    expect(replayed[0]?.output).toContain("decision: true");
    expect(asked).toEqual([]);

    // One answer, still spent, and one accepted event — before and after.
    expect(outcome.answersBefore).toEqual([
      { suspensionId: outcome.answersBefore[0]?.suspensionId ?? "", state: "consumed" },
    ]);
    expect(outcome.answersAfter).toEqual(outcome.answersBefore);
    expect(outcome.acceptedBefore).toBe(1);
    expect(outcome.acceptedAfter).toBe(1);
    expect(outcome.after.journal).toBe(outcome.before.journal);
  });

  it("WRP7: releases the run it replayed, and closed only its own envelope", function* () {
    const attached: string[] = [];

    const outcome = yield* scoped(function* () {
      const fixture = yield* useFixture(PLAIN);
      const started = yield* scoped(function* () {
        yield* useRepositoryGit(fixture.repository);
        return yield* invoke(
          REQUEST,
          yield* startFor(fixture),
          liveHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });
      const runId = runIdOf(started);

      yield* scoped(function* () {
        yield* useRefusingGit([]);
        return yield* invoke(
          { ...REQUEST, action: "resume", target: runId },
          undefined,
          replayHost(fixture.runs, attached),
          pinnedBody([]),
        );
      });

      // The acquisition ended with the invocation, so the next one takes it.
      const second = yield* scoped(function* () {
        yield* useWorkflowLifecycle({ root: fixture.runs });
        return yield* WorkflowLifecycle.operations.acquireExecutor(runId);
      });
      return { second, after: yield* retained(fixture.runs, runId) };
    });

    expect(outcome.second.ok).toBe(true);
    expect(outcome.second.ok === true && outcome.second.value.kind).toBe("acquired");
    // Two envelopes: the run's own execution and the replay's. Both are closed,
    // and the run is still the completed run it was.
    expect(outcome.after.executions).toBe(2);
    expect(outcome.after.status).toBe("completed");
  });
});

/** The production host with the settlement its storage refuses. */
function refusingSettlement(runs: string, attached: string[] = []): WorkflowHost {
  const live = liveHost(runs, attached);
  return {
    *useRunHost(): Operation<WorkflowExecutionTransitions> {
      const transitions = yield* live.useRunHost();
      return {
        begin: transitions.begin,
        fork: transitions.fork,
        stageFork: transitions.stageFork,
        // deno-lint-ignore require-yield
        *settle(): Operation<Result<never>> {
          return Err(new Error("PLANTED-STORAGE-REFUSAL"));
        },
      };
    },
    useLifecycle: live.useLifecycle,
    useDelivery: live.useDelivery,
    attach: live.attach,
  };
}

/**
 * A run this host created and then stopped holding, with the history a dead
 * executor left behind.
 *
 * Created through the same transitions production uses and left exactly as a
 * lost executor leaves a run: `running`, one execution nobody closed, and a
 * journal that already records what the document did.
 */
function* seedStaleRun(
  fixture: Fixture,
  start: WorkflowStart,
  events: (definition: WorkflowDefinition, runId: string) => readonly DurableEvent[],
  ending?: { readonly status: WorkflowRunStatus; readonly reason?: "root-close" },
): Operation<string> {
  return yield* scoped(function* () {
    const transitions = yield* useWorkflowRunHost({ root: fixture.runs });
    const runId = crypto.randomUUID();
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquired.ok) {
      throw acquired.error;
    }
    if (acquired.value.kind !== "acquired") {
      throw new Error(`${runId} already has a live workflow executor`);
    }
    const begun = yield* transitions.begin(acquired.value.lock, {
      runId,
      action: "start",
      creation: {
        definition: start.established.definition,
        base: start.established.base,
        props: {},
        retrieval: start.established.retrieval,
      },
    });
    if (!begun.ok) {
      throw begun.error;
    }
    for (const event of events(start.established.definition, runId)) {
      yield* begun.value.database.journal.append(event);
    }
    if (ending === undefined) {
      return runId;
    }
    // Settled by this same acquisition, so the run is left the way an executor
    // that finished leaves one rather than the way a lost one does.
    const entries = yield* begun.value.database.readJournalEntries();
    if (!entries.ok) {
      throw entries.error;
    }
    const close = entries.value.find(
      (entry) => entry.event.type === "close" && entry.event.coroutineId === "root",
    );
    const settled = yield* transitions.settle(acquired.value.lock, {
      executionId: begun.value.execution.executionId,
      status: ending.status,
      ...(ending.reason === undefined
        ? {}
        : { reason: { kind: "journal", eventId: close?.eventId ?? "" } }),
    });
    if (!settled.ok) {
      throw settled.error;
    }
    return runId;
  });
}

/** The history a run that raised out of its root leaves behind. */
function raisedHistory(
  start: WorkflowStart,
): (definition: WorkflowDefinition, runId: string) => readonly DurableEvent[] {
  return (definition, runId) => [
    forkRunRecordEvent({
      runId,
      base: start.established.base,
      pinnedCommit: definition.objectId,
    }),
    {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: {
        status: "ok",
        value: {
          kind: "repository",
          path: definition.rootDocumentPath,
          content: start.established.source,
        },
      },
    },
    {
      type: "close",
      coroutineId: "root",
      result: { status: "err", error: { message: "the executor died", name: "Error" } },
    },
  ];
}

/**
 * Take every retained event out of one run's journal, leaving its lifecycle row
 * saying the run ended.
 *
 * Damage rather than a scenario: what is under test is that the two halves are
 * required to agree, and a run cannot be brought into that state by asking the
 * lifecycle for it.
 */
function* emptyJournal(runs: string, runId: string): Operation<void> {
  const database = new DatabaseSync(workflowRunPath(runs, runId));
  try {
    database.prepare("DELETE FROM journal_events").run();
  } finally {
    database.close();
  }
  yield* until(Promise.resolve(undefined));
}

/**
 * Tier WAL — a workflow Agent's whole observation loop
 * (specs/workflow-workspace-spec.md §8).
 *
 * The vertical slice: a real workflow run, the real attachment, the real
 * `<Evaluate>` boundary and the representative document, with only the agent
 * process itself substituted. What is under test is the shape of the
 * conversation — one Prompt is one turn, the loop is Markdown, an observation
 * is admitted and performed against the run's Workspace, and a final proposal is
 * data — so everything that could make one of those true by accident is real.
 *
 * The document is `fixtures/workflow-agent/observation-loop.md`, read from disk
 * rather than restated here: a fixture a test rewrites is a fixture nobody runs.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile } from "@effectionx/fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, execute, retainedSource } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { withWorkflowWorkspace, workflowProviderSessions } from "@executablemd/workflow/deno";
import { useWorkflowAgentProfile } from "../src/workflow-agent.ts";
import type { WorkflowAgentProfileOptions as AgentProfileOptions } from "../src/workflow-agent.ts";
import { createFakeAcp, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp, ScriptedTurn } from "./support/fake-acp.ts";
import { createRun, useStorageRoot, withStorage } from "./support/workflow-run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-agent");

const NOTE = "the release checklist is three items long\n";

function* documentSource(): Operation<string> {
  return yield* readTextFile(join(FIXTURES, "observation-loop.md"));
}

/**
 * The fixture, with one Workspace write in front of it.
 *
 * The observation has to have something to read, and the run's Workspace starts
 * empty. Writing it from the document is how a real workflow would have got
 * there — an earlier step wrote it — and it keeps the fixture on disk
 * authoritative rather than restated here.
 */
function* documentWithNote(): Operation<string> {
  return `<File path="notes.md">${NOTE.trim()}</File>\n\n${yield* documentSource()}`;
}

/** One envelope the scripted agent replies with. */
function observation(source: string): ScriptedTurn {
  return { reply: JSON.stringify({ kind: "observation", source }) };
}

function proposal(source: string): ScriptedTurn {
  return { reply: JSON.stringify({ kind: "proposal", source }) };
}

interface Attempt {
  output?: Json;
  failure?: string;
  events: DurableEvent[];
}

/**
 * Run the fixture as this run's root document, with the workflow Agent profile
 * attached.
 *
 * The contextual working directory is somewhere the run may not reach and a host
 * Files provider is installed outside the attachment, so a read that fell
 * through to the caller's filesystem would be visible rather than silent.
 */
function runFixture(
  root: string,
  database: WorkflowRunDatabase,
  source: string,
  options: {
    readonly createRuntime?: AgentProfileOptions["createRuntime"];
    /**
     * The provider's persistent session store.
     *
     * Shared between two attempts where a restart is being modelled: ACPX keeps
     * its sessions across processes, and a fresh store would be a provider that
     * forgot rather than a process that restarted.
     */
    readonly sessionStore?: AgentProfileOptions["sessionStore"];
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return "/nowhere-the-workflow-may-reach";
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    let output: Json | undefined;
    let failure: string | undefined;
    try {
      output = yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* execute({
              ...retainedSource("workflows/observation-loop.md", source),
              stream: database.journal,
            }),
          );
        }),
        {
          agent: (attachment) =>
            useWorkflowAgentProfile({
              root,
              attachment,
              defaultAgent: "codex",
              sessionStore: options.sessionStore ?? makeStore(),
              ...(options.createRuntime === undefined
                ? {}
                : { createRuntime: options.createRuntime }),
            }),
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return {
      ...(output === undefined ? {} : { output }),
      ...(failure === undefined ? {} : { failure }),
      events: yield* database.journal.readAll(),
    };
  });
}

function typed(events: DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === type);
}

/** Every generated-XMD record that admitted its fragment. */
function admitted(events: DurableEvent[]): DurableEvent[] {
  return typed(events, "generated_xmd").filter((event) => {
    if (event.type !== "yield" || event.result.status !== "ok") {
      return false;
    }
    const value = event.result.value;
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value.decision === "admitted"
    );
  });
}

function reported(attempt: Attempt): string {
  if (attempt.failure !== undefined) {
    return attempt.failure;
  }
  return typeof attempt.output === "string" ? attempt.output : JSON.stringify(attempt.output);
}

/** Every session key the fake was asked to establish, deduplicated in order. */
function sessions(fake: FakeAcp): string[] {
  return [...new Set(fake.ensured.map((input) => input.sessionKey))];
}

describe("Tier WAL — the workflow Agent observation loop", () => {
  it("WAL1: two observations then a proposal, all in one provider session", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script(observation(`<File path="notes.md" />`));
      fake.script(observation(`<File path="notes.md" />`));
      fake.script(proposal("Trim the checklist to two items."));

      const attempt = yield* runFixture(root, database, source, { createRuntime: fake.create });

      expect(attempt.failure).toBe(undefined);
      // Three turns, and the exact proposal came back.
      expect(fake.prompts).toHaveLength(3);
      expect(reported(attempt)).toContain("Trim the checklist to two items.");

      // Two admissions, both admitted, and two ordinary Workspace file reads.
      expect(admitted(attempt.events)).toHaveLength(2);
      expect(typed(attempt.events, "workspace_file").length).toBeGreaterThanOrEqual(2);

      // One session throughout — the same key and the same native identity.
      expect(sessions(fake)).toHaveLength(1);
      const native = new Set(fake.ensured.map((input) => `agent-session:${input.sessionKey}`));
      expect(native.size).toBe(1);

      // The observation reached the next turn: the second prompt carries what
      // the first read returned, and the first does not.
      expect(fake.prompts[0]).not.toContain(NOTE.trim());
      expect(fake.prompts[1]).toContain(NOTE.trim());
    });
  });

  it("WAL1: no Workspace path or caller path reaches the provider", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script(proposal("nothing to change"));
      yield* runFixture(root, database, source, { createRuntime: fake.create });

      const setup = JSON.stringify({
        created: fake.created.map((options) => options.cwd),
        ensured: fake.ensured,
      });
      // The run's own sidecar, and nothing of the Workspace or the caller.
      expect(setup).toContain(".sessions");
      expect(setup).not.toContain("/nowhere-the-workflow-may-reach");
      expect(setup).not.toContain("notes.md");
      // Asked for, explicitly, rather than omitted.
      expect(fake.created[0]?.mcpServers).toEqual([]);
      expect(fake.ensured[0]?.sessionOptions?.allowedTools).toEqual([]);
    });
  });

  it("WAL2: a completed replay restores the run and reaches no provider", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const store = makeStore();

      const live = createFakeAcp();
      live.script(observation(`<File path="notes.md" />`));
      live.script(proposal("Trim the checklist to two items."));
      const first = yield* runFixture(root, database, source, {
        createRuntime: live.create,
        sessionStore: store,
      });
      expect(first.failure).toBe(undefined);
      const committed = first.events.length;

      // The same document again, over the journal the first attempt wrote, with
      // a runtime nothing may reach.
      const reached: string[] = [];
      const replay = yield* runFixture(root, database, source, {
        createRuntime: tripwireAcp((what) => reached.push(what)),
        sessionStore: store,
      });

      // Identical output, and the provider was never entered — not even to
      // create a runtime.
      expect(replay.failure).toBe(undefined);
      expect(reported(replay)).toBe(reported(first));
      expect(reached).toEqual([]);
      // Nothing new was journaled: every prompt, admission and read restored.
      expect(replay.events.length).toBe(committed);
    });
  });

  it("WAL3: an interrupted run resumes without repeating what it committed", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // One store across both attempts: ACPX keeps its sessions across
      // processes, so a restart finds the session the first attempt established.
      const store = makeStore();

      const interrupted = createFakeAcp();
      interrupted.script(observation(`<File path="notes.md" />`));
      // The next turn never settles. Halting the attempt while it is in flight
      // is an interruption rather than a failure, which is what leaves work for
      // a resume to finish — a document that *failed* deterministically would
      // simply replay that failure.
      interrupted.script({ reply: "", manual: true });

      const attempt = yield* spawn(() =>
        runFixture(root, database, source, {
          createRuntime: interrupted.create,
          sessionStore: store,
        }),
      );
      yield* sleep(120);
      yield* attempt.halt();

      const first = yield* database.journal.readAll();
      const committedAdmissions = admitted(first).length;
      const committedReads = typed(first, "workspace_file").length;
      expect(committedAdmissions).toBe(1);
      expect(interrupted.prompts).toHaveLength(2);

      const resumed = createFakeAcp();
      resumed.script(proposal("Trim the checklist to two items."));
      const second = yield* runFixture(root, database, source, {
        createRuntime: resumed.create,
        sessionStore: store,
      });

      expect(second.failure).toBe(undefined);
      expect(reported(second)).toContain("Trim the checklist to two items.");

      // The committed turn was restored rather than re-sent: this attempt asked
      // the agent only for the turn the first one never finished.
      expect(resumed.prompts).toHaveLength(1);
      // And the committed observation was not performed a second time — the
      // first read stayed exactly one read.
      // The committed observation was restored, not performed again: the run
      // ended with exactly the reads it already had.
      expect(admitted(second.events).length).toBe(committedAdmissions);
      expect(typed(second.events, "workspace_file").length).toBe(committedReads);

      // Reattached, under the same logical key the first attempt established.
      expect(resumed.ensured.map((input) => input.sessionKey)).toEqual(
        interrupted.ensured.map((input) => input.sessionKey),
      );
    });
  });

  it("WAL4: exhausting the authored bound fails at the document's own gate", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      // Never proposes: the document's `<Loop max={4}>` runs out.
      for (let turn = 0; turn < 4; turn += 1) {
        fake.script(observation(`<File path="notes.md" />`));
      }

      const attempt = yield* runFixture(root, database, source, { createRuntime: fake.create });

      // Exhaustion is not the loop's failure — it is the final gate refusing an
      // observation where a proposal was required.
      expect(reported(attempt)).toMatch(/proposal|const/i);
      expect(fake.prompts).toHaveLength(4);
      // And the evidence that produced it is retained: four turns, four
      // admissions.
      expect(typed(attempt.events, "agent_prompt")).toHaveLength(4);
      expect(admitted(attempt.events)).toHaveLength(4);
    });
  });

  it("WAL5: a mutation-shaped proposal is retained as data and mutates nothing", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const mutation = `<File path="notes.md">the agent rewrote this</File>`;
      const fake = createFakeAcp();
      fake.script(proposal(mutation));

      const attempt = yield* runFixture(root, database, source, { createRuntime: fake.create });

      expect(attempt.failure).toBe(undefined);
      // The exact source came back, unchanged.
      expect(reported(attempt)).toContain(mutation);
      // And nothing performed it: no admission at all, so no observation ran.
      expect(admitted(attempt.events)).toHaveLength(0);
      // The run's own history is the evidence about its Workspace. Exactly one
      // file effect happened — the setup write — so the proposal's `<File>`
      // wrote nothing.
      expect(typed(attempt.events, "workspace_file")).toHaveLength(1);
    });
  });

  it("WAL6: a denied native tool becomes the retained Prompt failure", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const marker = "/etc/shadow";
      const fake = createFakeAcp();
      fake.script({
        reply: JSON.stringify({ kind: "proposal", source: "x" }),
        requestsTool: marker,
      });

      const attempt = yield* runFixture(root, database, source, { createRuntime: fake.create });

      // Rejected where ACP offered a rejection.
      expect(fake.decisions).toEqual(["reject_once"]);
      // The turn failed, and the failure is retained rather than inferred.
      const prompts = typed(attempt.events, "agent_prompt");
      expect(prompts).toHaveLength(1);
      const retained = JSON.stringify(prompts[0]);
      expect(retained).toContain("native tool");
      // Nothing the request carried reached the record.
      expect(retained).not.toContain(marker);
    });
  });

  it("WAL7: a workflow with no Agent starts no provider and allocates no sidecar", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const reached: string[] = [];

      const attempt = yield* runFixture(
        root,
        database,
        "# An ordinary workflow\n\nIt prompts nobody.\n",
        { createRuntime: tripwireAcp((what) => reached.push(what)) },
      );

      expect(attempt.failure).toBe(undefined);
      // The provider was installed and never entered: no runtime, no session,
      // no process.
      expect(reached).toEqual([]);
      expect(yield* exists(workflowProviderSessions(root, database.record.runId))).toBe(false);
    });
  });
});

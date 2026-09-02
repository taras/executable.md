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
import { scoped, spawn } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readTextFile } from "@effectionx/fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, execute, retainedSource } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { RuntimeFetchResponse } from "@executablemd/runtime";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import {
  evaluationComponents,
  transactAgentPromptCheckpoints,
  withWorkflowWorkspace,
  workflowRunPath,
  workflowProviderSessions,
} from "@executablemd/workflow/deno";
import { executeInstalled } from "@executablemd/core/host";
import { agentIdentityComponents } from "@executablemd/core";
import { useWorkflowAgentProfile, WORKFLOW_SESSION_INSTRUCTIONS } from "../src/workflow-agent.ts";
import type { EmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { WorkflowAgentProfileOptions as AgentProfileOptions } from "../src/workflow-agent.ts";
import { createFakeAcp, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp, ScriptedTurn } from "./support/fake-acp.ts";
import { createRun, useStorageRoot, withStorage } from "./support/workflow-run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-agent");

const NOTE = "the release checklist is three items long\n";

/**
 * What ACPX resolves this agent to, and what the base branch retained for it.
 *
 * Written out rather than read back through `createAgentRegistry()`, because
 * the claim is that this value did not move. Recomputing it from the same
 * registry the profile now overlays would agree with whatever that registry
 * currently says, which is not the thing being asserted.
 */
const GEMINI_COMMAND = "gemini --acp";

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
/** The one-Prompt document that asks an agent this build carries no snapshot for. */
function* baselineAgentSource(): Operation<string> {
  return yield* readTextFile(join(FIXTURES, "baseline-agent.md"));
}

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

/**
 * Embedded adapters that install nothing.
 *
 * These suites substitute the ACPX runtime, so no adapter is ever spawned and a
 * real `npm install` of one would be minutes of network for a process that
 * never starts. What still matters is *that the profile asks* — so this records
 * every request, and Tier AM proves what the real one does with it.
 */
function stubAdapters(): EmbeddedAdapters & { readonly materialized: string[] } {
  const materialized: string[] = [];
  /**
   * `answer`, but only for a provider this build carries.
   *
   * The real one raises for anything else, and so must this: a profile that
   * reached into the snapshots to ask about an agent ACPX resolves would
   * otherwise go unnoticed here, which is the whole thing WAL13 is about.
   */
  const carried = <T>(provider: string, answer: T): T => {
    if (provider !== "codex" && provider !== "claude") {
      throw new Error(`no embedded snapshot for ${provider}`);
    }
    return answer;
  };
  return {
    materialized,
    providers: ["codex", "claude"],
    // Stable, and deliberately carrying no path: this is what a retained
    // session and a sealed artifact record, so it must not vary with where a
    // host materialized anything.
    identity(provider) {
      return carried(provider, `xmd-embedded-adapter:${provider}:test@0.0.0+${"0".repeat(64)}`);
    },
    executablePath(provider) {
      return carried(provider, `/nonexistent/${provider}-adapter.js`);
    },
    command(provider) {
      return carried(provider, `node "/nonexistent/${provider}-adapter.js"`);
    },
    // deno-lint-ignore require-yield
    *materialize(provider: string): Operation<void> {
      carried(provider, provider);
      materialized.push(provider);
    },
  };
}

/** Every Agent session one run retained, as its database holds it. */
function retainedSessions(path: string): Record<string, unknown>[] {
  const database = new DatabaseSync(path);
  try {
    return database.prepare("SELECT * FROM agent_sessions ORDER BY session_key").all();
  } finally {
    database.close();
  }
}

/** A turn identity that exists nowhere else in this repository. */
const TOKEN_VALUE = "wal-canary-turn-6b3f9d";

/** The kind this host records that identity under. */
const TOKEN_KIND = "app-server-turn-id";

/** Which provider turn each Prompt of this run was, as the run retained it. */
function* retained(
  database: WorkflowRunDatabase,
): Operation<{ eventId: string; tokenKind: string; tokenValue: string }[]> {
  const read = yield* transactAgentPromptCheckpoints(database, function* (checkpoints) {
    return checkpoints.readAll();
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value.map((row) => ({
    eventId: row.eventId,
    tokenKind: row.tokenKind,
    tokenValue: row.tokenValue,
  }));
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
    /** What this host admits a generated fragment under, beyond the standard profile. */
    readonly evaluation?: { readonly requests?: readonly Record<string, Json>[] };
    /** The root props this run was started with. */
    readonly props?: Record<string, Json>;
    /** Answers one admitted HTTP read, and counts what was asked for. */
    readonly transport?: { readonly performed: string[] };
    /** The embedded adapters this attachment materializes from. */
    readonly adapters?: EmbeddedAdapters;
    /** The agent a `<Session>` gets when its document names none. */
    readonly defaultAgent?: string;
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
    if (options.transport) {
      const performed = options.transport.performed;
      yield* API.Fetch.around(
        {
          // deno-lint-ignore require-yield
          *fetch([url]): Operation<RuntimeFetchResponse> {
            performed.push(url);
            const headers: Array<[string, string]> = [["content-type", "text/plain"]];
            return {
              status: 200,
              headers: {
                get: (key: string) =>
                  headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? null,
                entries: () => headers,
              },
              // deno-lint-ignore require-yield
              *text(): Operation<string> {
                return "the release notes are ready";
              },
            };
          },
        },
        { at: "min" },
      );
    }
    let output: Json | undefined;
    let failure: string | undefined;
    try {
      output = yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource("workflows/observation-loop.md", source),
                stream: database.journal,
                ...(options.props === undefined ? {} : { props: options.props }),
              },
              // Both words this document writes name durable work after their
              // own invocations, so the host declares them to the execution and
              // canonical execution builds each from the claimant it minted.
              [
                {
                  components: [
                    ...evaluationComponents(database, options.evaluation ?? {}),
                    ...agentIdentityComponents(),
                  ],
                },
              ],
            ),
          );
        }),
        {
          agent: (attachment) =>
            useWorkflowAgentProfile({
              root,
              attachment,
              defaultAgent: options.defaultAgent ?? "codex",
              sessionStore: options.sessionStore ?? makeStore(),
              adapters: options.adapters ?? stubAdapters(),
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

      // The session's fixed instruction layer states the whole boundary, not
      // half of it: no native tool authority, observation only through the
      // closed shape the current prompt supplies, and no authority in anything
      // the agent returns.
      const instructions = fake.ensured[0]?.sessionOptions?.systemPrompt;
      expect(typeof instructions).toBe("string");
      expect(instructions).toBe(WORKFLOW_SESSION_INSTRUCTIONS);
      const stated = typeof instructions === "string" ? instructions : "";
      expect(stated).toContain("no native tool authority");
      expect(stated).toContain("only in the exact closed shape that prompt supplies");
      expect(stated).toContain("Nothing you return carries authority");
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
      // The barrier, not a delay: the first turn has committed its observation
      // and the second — the manual one — is in flight. A delay here is a race
      // that halts before the first admission commits often enough to matter.
      yield* interrupted.startedTurns(2);
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
      // The keys, not how many times each attempt asked for one: the first
      // attempt placed a session and constructed it at its first Prompt, and
      // this one meets a session that already exists and attaches to it — so
      // the counts differ for the reason the reattachment is being made.
      expect(new Set(resumed.ensured.map((input) => input.sessionKey))).toEqual(
        new Set(interrupted.ensured.map((input) => input.sessionKey)),
      );
    });
  });

  it("WAL10: a named turn is retained against its Prompt and rendered nowhere", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script({ ...observation(`<File path="notes.md" />`), turnId: `${TOKEN_VALUE}-1` });
      fake.script({ ...proposal("Trim the checklist to two items."), turnId: `${TOKEN_VALUE}-2` });

      const attempt = yield* runFixture(root, database, source, { createRuntime: fake.create });

      expect(attempt.failure).toBe(undefined);
      // Retained, and against the run's own Prompt events. Without this the
      // absence below would be the absence of something that never existed.
      const rows = yield* retained(database);
      expect(rows.map((row) => row.tokenValue)).toEqual([`${TOKEN_VALUE}-1`, `${TOKEN_VALUE}-2`]);
      expect(rows.every((row) => row.tokenKind === TOKEN_KIND)).toBe(true);
      const promptEvents = typed(attempt.events, "agent_prompt").map((event) => event);
      expect(promptEvents).toHaveLength(2);

      // And present in nothing a reader sees. The rendered document is what the
      // person running it reads, and the journal is what an inspection prints.
      const rendered = reported(attempt);
      expect(rendered).not.toContain(TOKEN_VALUE);
      expect(rendered).not.toContain(TOKEN_KIND);
      const journal = JSON.stringify(attempt.events);
      expect(journal).not.toContain(TOKEN_VALUE);
      expect(journal).not.toContain(TOKEN_KIND);
    });
  });

  it("WAL8: an admitted Fetch response reaches the next Prompt, values and all", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();
    const url = "https://api.example.test/release";

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const transport = { performed: [] as string[] };

      const fake = createFakeAcp();
      fake.script(observation(`<Fetch url="${url}" />`));
      fake.script(proposal("The release notes are ready, so ship it."));

      const attempt = yield* runFixture(root, database, source, {
        createRuntime: fake.create,
        evaluation: { requests: [{ url }] },
        transport,
      });

      expect(attempt.failure).toBe(undefined);
      expect(transport.performed).toEqual([url]);

      // `<Fetch>` written without a binding renders nothing at all — a
      // component returning a non-string has nowhere to render. The retained
      // response still has to reach the agent, so the second prompt carries the
      // status and the body it never saw rendered.
      expect(fake.prompts).toHaveLength(2);
      const second = fake.prompts[1] ?? "";
      // The complete retained response, not a summary of it: status, headers and
      // body, under the observation's own name and in invocation order.
      expect(second).toContain('"name": "Fetch"');
      expect(second).toContain('"status": 200');
      expect(second).toContain('"content-type"');
      expect(second).toContain("text/plain");
      expect(second).toContain("the release notes are ready");
      // And the fragment's own rendering, kept beside the values rather than
      // standing in for them — an uncaptured `<Fetch>` renders nothing.
      expect(second).toContain('"output": ""');
      // The first prompt had no observation yet, so the difference is the
      // observation rather than the document's own prose.
      expect(fake.prompts[0]).not.toContain("the release notes are ready");
    });
  });

  it("WAL8: a completed replay restores that response without asking again", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();
    const url = "https://api.example.test/release";

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const store = makeStore();
      const live = createFakeAcp();
      live.script(observation(`<Fetch url="${url}" />`));
      live.script(proposal("The release notes are ready, so ship it."));
      const performed: string[] = [];

      const first = yield* runFixture(root, database, source, {
        createRuntime: live.create,
        sessionStore: store,
        evaluation: { requests: [{ url }] },
        transport: { performed },
      });
      expect(first.failure).toBe(undefined);
      expect(performed).toEqual([url]);
      const observed = live.prompts[1] ?? "";
      expect(observed).toContain("the release notes are ready");

      // The same document over its own journal: the response is restored from
      // the retained `fetch` effect, and neither the agent nor the server is
      // asked anything.
      const replayed: string[] = [];
      const reached: string[] = [];
      const replay = yield* runFixture(root, database, source, {
        createRuntime: tripwireAcp((what) => reached.push(what)),
        sessionStore: store,
        evaluation: { requests: [{ url }] },
        transport: { performed: replayed },
      });

      expect(replay.failure).toBe(undefined);
      expect(reported(replay)).toBe(reported(first));
      expect(reached).toEqual([]);
      expect(replayed).toEqual([]);
      expect(replay.events.length).toBe(first.events.length);
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

  it("WAL9: an approved proposal is applied, and a refused one is not", function* () {
    const source = yield* readTextFile(join(FIXTURES, "approved-proposal.md"));
    const change = `<Dir path="nested">\n\n<File path="out.md">the agent's change</File>\n\n</Dir>\n`;

    const approved = yield* useStorageRoot();
    yield* withStorage(approved, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script(proposal(change));

      const attempt = yield* runFixture(approved, database, source, {
        createRuntime: fake.create,
        props: { approved: true },
      });

      expect(attempt.failure).toBe(undefined);
      // The standard profile admitted it: one record, naming both write
      // identities and the classes the document selected.
      const recorded = admitted(attempt.events);
      expect(recorded).toHaveLength(1);
      const policy = JSON.stringify(recorded[0]);
      expect(policy).toContain("File:write");
      expect(policy).toContain("@executablemd/workflow/composition/dir-v2#Dir");
      expect(policy).toContain('"allow":["write"]');
      // And the change is in the run's own Workspace, where an ordinary read
      // beneath the fragment's own directory finds it. Anchored on the
      // document's own sentence: the proposal is echoed further up, so a bare
      // substring would be satisfied by the echo rather than by the read.
      expect(reported(attempt)).toMatch(/now holds:\s*the agent's change/);
      expect(typed(attempt.events, "workspace_file").length).toBeGreaterThanOrEqual(1);
    });

    const refused = yield* useStorageRoot();
    yield* withStorage(refused, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script(proposal(change));

      const attempt = yield* runFixture(refused, database, source, {
        createRuntime: fake.create,
        props: { approved: false },
      });

      expect(attempt.failure).toBe(undefined);
      // The same proposal, the same host, and the branch that reaches
      // `<Evaluate>` never taken: no admission exists, so no mutation does.
      expect(reported(attempt)).toContain("Nobody approved it");
      expect(admitted(attempt.events)).toHaveLength(0);
      expect(typed(attempt.events, "generated_xmd")).toHaveLength(0);
      expect(typed(attempt.events, "workspace_file")).toHaveLength(0);
    });
  });

  it("WAL11: the profile materializes the adapter a placement names, and only then", function* () {
    const root = yield* useStorageRoot();
    const source = yield* documentWithNote();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script(proposal("nothing to change"));
      const adapters = stubAdapters();

      yield* runFixture(root, database, source, { createRuntime: fake.create, adapters });

      // Asked for, by name, before ACPX was contacted — which is what makes a
      // broken snapshot a refusal rather than a Prompt sent to whatever `npx`
      // would have resolved.
      expect(adapters.materialized).toContain("codex");
    });
  });

  it("WAL12: two hosts retain and serialize identical Agent identity, launching their own adapters", function* () {
    const source = yield* documentWithNote();

    /**
     * One complete run under its own materialization root.
     *
     * Real embedded adapters, because the claim is about what a real
     * materialization retains — a stub would be asserting on a value this test
     * had chosen.
     */
    function* runUnder(root: string): Operation<{
      sessions: Record<string, unknown>[];
      launch: string;
      identity: string;
    }> {
      yield* ensureDir(root);
      const adapters = createEmbeddedAdapters(join(root, "adapters"));
      return yield* withStorage(root, function* () {
        const database = yield* createRun();
        const fake = createFakeAcp();
        fake.script({ ...proposal("nothing to change"), turnId: "turn-shared" });
        const attempt = yield* runFixture(root, database, source, {
          createRuntime: fake.create,
          adapters,
        });
        expect(attempt.failure).toBe(undefined);

        return {
          // Read straight out of the file, because the durable row is the claim
          // — it is what a later attachment compares and what the artifact
          // encoder writes `agentCommand` from.
          sessions: retainedSessions(workflowRunPath(root, "observation-run")),
          launch: adapters.executablePath("codex"),
          identity: adapters.identity("codex"),
        };
      });
    }

    const plainRoot = join(yield* useStorageRoot(), "plain");
    // A spaced canary, because an unquoted path would split here and a path
    // that leaked into identity would differ between the two.
    const spacedRoot = join(yield* useStorageRoot(), "Application Support", "xmd runs");

    const here = yield* runUnder(plainRoot);
    const there = yield* runUnder(spacedRoot);

    // What the run retains, and therefore what a sealed artifact serializes:
    // `encodeXmdArtifactInventory` writes `agentCommand` straight out of this
    // row, so identical rows are identical artifact semantics.
    //
    // Everything except when it happened. `created_at` is a timestamp rather
    // than identity, and it is named here so that the equality below is a claim
    // about every other column rather than a comparison that quietly skips
    // whichever ones happened to differ.
    const semantics = (rows: Record<string, unknown>[]) =>
      JSON.stringify(rows.map(({ created_at: _when, ...rest }) => rest));
    expect(semantics(there.sessions)).toBe(semantics(here.sessions));
    expect(there.identity).toBe(here.identity);
    // The identity column specifically, since that is the one an artifact
    // carries and the one that used to be a path.
    expect(here.sessions[0]?.["agent_command"]).toBe(here.identity);
    expect(there.sessions[0]?.["agent_command"]).toBe(here.identity);

    // Neither host's path is anywhere in what was retained.
    const retained = JSON.stringify(here.sessions) + JSON.stringify(there.sessions);
    expect(retained).not.toContain(plainRoot);
    expect(retained).not.toContain(spacedRoot);
    expect(retained).not.toContain("adapters/");

    // And each host still launches its own local executable.
    expect(there.launch).not.toBe(here.launch);
    expect(here.launch).toContain(plainRoot);
    expect(there.launch).toContain(spacedRoot);
  });

  it("WAL13: an agent this build carries no snapshot for runs through ACPX unchanged", function* () {
    const root = yield* useStorageRoot();
    const source = yield* baselineAgentSource();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      // No turn identity, because the published Gemini adapter reports none.
      // That is the ordinary case for every agent this build does not patch.
      fake.script({ reply: "The release is ready." });
      fake.script({ reply: "Nothing is blocking it." });
      const adapters = stubAdapters();

      const attempt = yield* runFixture(root, database, source, {
        createRuntime: fake.create,
        adapters,
      });

      // It completes. Carrying a patched Codex adapter is not a reason for a
      // run to lose an agent it could always use.
      expect(attempt.failure).toBe(undefined);
      expect(reported(attempt)).toContain("The release is ready.");

      // Resolved through ACPX's own registry, to ACPX's own command. The
      // provider is handed one registry; this is the command it answered with.
      expect(fake.created[0]?.agentRegistry.resolve("gemini")).toBe(GEMINI_COMMAND);
      expect(fake.ensured[0]?.agent).toBe("gemini");

      // The embedded machinery was never asked about it — not to capture it,
      // not to verify it, not to put anything on disk. The stub raises for a
      // provider it does not carry, so any of those would have failed the run.
      expect(adapters.materialized).toEqual([]);

      // The ordinary Prompt events are retained exactly as they always were.
      expect(typed(attempt.events, "agent_prompt")).toHaveLength(2);

      // And nothing was associated, because nothing named a turn. An absent
      // checkpoint is not a failed Prompt: the event above is the proof that
      // this zero is a zero rather than a run that did not happen.
      expect(yield* retained(database)).toEqual([]);
    });
  });

  it("WAL14: a completed and an interrupted run both replay from the stored Prompt", function* () {
    const source = yield* baselineAgentSource();

    // A completed run, replayed whole.
    const completedRoot = yield* useStorageRoot();
    yield* withStorage(completedRoot, function* () {
      const database = yield* createRun();
      const store = makeStore();

      const live = createFakeAcp();
      live.script({ reply: "The release is ready." });
      live.script({ reply: "Nothing is blocking it." });
      const first = yield* runFixture(completedRoot, database, source, {
        createRuntime: live.create,
        sessionStore: store,
      });
      expect(first.failure).toBe(undefined);
      const committed = first.events.length;

      // The same document again, over the journal the first attempt wrote, with
      // a runtime nothing may reach — not even to create one.
      const reached: string[] = [];
      const replay = yield* runFixture(completedRoot, database, source, {
        createRuntime: tripwireAcp((what) => reached.push(what)),
        sessionStore: store,
      });
      expect(replay.failure).toBe(undefined);
      expect(reported(replay)).toBe(reported(first));
      expect(reached).toEqual([]);
      expect(replay.events.length).toBe(committed);
      // And still nothing associated. A run that retained no checkpoint
      // replays from the stored Prompt alone, exactly like one that did.
      expect(yield* retained(database)).toEqual([]);
    });

    // An interrupted run, resumed. This is the partial case: one Prompt is on
    // the journal and one never finished.
    const partialRoot = yield* useStorageRoot();
    yield* withStorage(partialRoot, function* () {
      const database = yield* createRun();
      const store = makeStore();

      const interrupted = createFakeAcp();
      interrupted.script({ reply: "The release is ready." });
      // Never settles. Halting while it is in flight is an interruption rather
      // than a failure, which is what leaves work for a resume to finish.
      interrupted.script({ reply: "", manual: true });

      const attempt = yield* spawn(() =>
        runFixture(partialRoot, database, source, {
          createRuntime: interrupted.create,
          sessionStore: store,
        }),
      );
      // The barrier, not a delay: the first turn has committed and the second is
      // in flight.
      yield* interrupted.startedTurns(2);
      yield* attempt.halt();
      expect(interrupted.prompts).toHaveLength(2);

      const resumed = createFakeAcp();
      // Scripted for the unfinished turn only. If the committed Prompt were
      // re-sent, this fake would answer it with the wrong reply and run out.
      resumed.script({ reply: "Nothing is blocking it." });
      const second = yield* runFixture(partialRoot, database, source, {
        createRuntime: resumed.create,
        sessionStore: store,
      });

      expect(second.failure).toBe(undefined);
      expect(reported(second)).toContain("The release is ready.");
      expect(reported(second)).toContain("Nothing is blocking it.");
      // The committed turn was restored rather than asked again: this attempt
      // contacted the provider only for the turn the first one never finished.
      expect(resumed.prompts).toHaveLength(1);
      // Reattached under the same logical key the first attempt established.
      // The keys, not the counts: the first attempt placed a session and
      // constructed it at its first Prompt, and this one attaches to one that
      // already exists.
      expect(new Set(resumed.ensured.map((input) => input.sessionKey))).toEqual(
        new Set(interrupted.ensured.map((input) => input.sessionKey)),
      );
      // Two completed Prompts on the journal and no association for either.
      expect(typed(second.events, "agent_prompt")).toHaveLength(2);
      expect(yield* retained(database)).toEqual([]);
    });
  });

  it("WAL15: its retained identity is the resolved command, as it was before", function* () {
    const root = yield* useStorageRoot();
    const source = yield* baselineAgentSource();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script({ reply: "The release is ready." });
      fake.script({ reply: "Nothing is blocking it." });

      const attempt = yield* runFixture(root, database, source, { createRuntime: fake.create });
      expect(attempt.failure).toBe(undefined);

      // The compatibility attribute a reattachment compares and an artifact
      // seals. For an agent this build does not override it is ACPX's resolved
      // command and nothing else — the same value this profile retained before
      // any adapter was embedded, so a session retained by an earlier run of
      // the same workflow is still that session.
      const rows = retainedSessions(workflowRunPath(root, "observation-run"));
      expect(rows).toHaveLength(1);
      // Two claims, and they are different ones. That the retained value *is*
      // what the registry resolved, and that what the registry resolved is
      // ACPX's own built-in — the literal the base branch retained for this
      // agent, written out rather than recomputed through the code under test.
      expect(rows[0]?.["agent_command"]).toBe(fake.created[0]?.agentRegistry.resolve("gemini"));
      expect(rows[0]?.["agent_command"]).toBe(GEMINI_COMMAND);
      // Specifically not restated as an embedded identity, which is what a
      // registry closed to the two patched providers would have forced.
      expect(String(rows[0]?.["agent_command"])).not.toContain("xmd-embedded-adapter");
    });
  });

  it("WAL16: a refusing snapshot refuses its own agent and leaves the others alone", function* () {
    // Two runs, two roots. There is one run id per store, so the second half
    // has to be a fresh run rather than a continuation of the first one's
    // journal — which would replay a Codex placement into a Gemini document.
    const refusedRoot = yield* useStorageRoot();
    const unaffectedRoot = yield* useStorageRoot();

    /**
     * Embedded adapters that carry both names and can produce neither.
     *
     * They refuse anything they do not carry, exactly as the real one does.
     * Without that, the second half below would pass against a registry that
     * routed Gemini through here too — it would simply answer with a nonsense
     * command that the substituted runtime never tries to spawn.
     */
    function brokenAdapters(): EmbeddedAdapters {
      const carried = <T>(provider: string, answer: T): T => {
        if (provider !== "codex" && provider !== "claude") {
          throw new Error(`no embedded snapshot for ${provider}`);
        }
        return answer;
      };
      return {
        providers: ["codex", "claude"],
        identity: (provider) => carried(provider, `xmd-embedded-adapter:${provider}:broken@0.0.0`),
        executablePath: (provider) => carried(provider, `/nonexistent/${provider}.js`),
        command: (provider) => carried(provider, `node "/nonexistent/${provider}.js"`),
        // deno-lint-ignore require-yield
        *materialize(provider: string): Operation<void> {
          carried(provider, provider);
          throw new Error(`the ${provider} snapshot cannot be verified`);
        },
      };
    }

    yield* withStorage(refusedRoot, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script(proposal("nothing to change"));

      const attempt = yield* runFixture(refusedRoot, database, yield* documentWithNote(), {
        createRuntime: fake.create,
        adapters: brokenAdapters(),
      });

      // Refused, by the snapshot's own words, and before any turn: the run
      // never sent a Prompt and never fell through to the published Codex
      // adapter, which would have completed everything and retained nothing.
      expect(attempt.failure).toContain("cannot be verified");
      expect(fake.prompts).toEqual([]);
      expect(yield* retained(database)).toEqual([]);
    });

    // The same broken snapshots, and an agent they have nothing to do with.
    yield* withStorage(unaffectedRoot, function* () {
      const database = yield* createRun();
      const fake = createFakeAcp();
      fake.script({ reply: "The release is ready." });
      fake.script({ reply: "Nothing is blocking it." });

      const attempt = yield* runFixture(unaffectedRoot, database, yield* baselineAgentSource(), {
        createRuntime: fake.create,
        adapters: brokenAdapters(),
      });

      // Unaffected. The refusal belongs to the override, not to the registry:
      // a snapshot this run never needed cannot take an unrelated agent down
      // with it.
      expect(attempt.failure).toBe(undefined);
      expect(fake.prompts).toHaveLength(2);
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

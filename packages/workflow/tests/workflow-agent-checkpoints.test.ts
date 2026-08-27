/**
 * Tier WPC — which provider turn each of a run's Prompts was
 * (specs/workflow-workspace-spec.md §8.6).
 *
 * A retained Agent session says which conversation this run is having. A
 * checkpoint says where in that conversation one Prompt landed. The claim under
 * test is that the second fact commits with the Prompt it describes and with
 * nothing else — so these drive the real publisher, the real transaction and the
 * real table against a real run database. A stand-in for any of them would be a
 * stand-in for exactly what is being claimed.
 *
 * The provider here is a fake, and deliberately so: what an adapter puts on a
 * response is `packages/acp`'s question, and it is answered under Tier APC and
 * Tier TC. What this asks is what a run does with the answer.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { executeInstalled } from "@executablemd/core/host";
import { useAgentPromptPublisher } from "@executablemd/core/host";
import {
  Agent,
  agentIdentityComponents,
  collect,
  inlineSource,
  installAgentComponents,
} from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderAuthority,
  AgentProviderFactory,
  Json,
  Session,
} from "@executablemd/core";
import type { DurableEvent } from "@executablemd/durable-streams";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Stream } from "effection";
import type { WorkflowRunDatabase } from "../mod.ts";
import {
  agentSessionKey,
  createWorkflowPromptPublisher,
  transactAgentPromptCheckpoints,
  transactAgentSessions,
} from "../deno.ts";
import type { AgentPromptCheckpointRecord, AgentSessionIdentity } from "../deno.ts";
import {
  committedEventCount,
  createRun,
  runPath,
  tamper,
  useStorageRoot,
  withStorage,
} from "./support/storage.ts";

const PROVIDER = "acpx";
const AGENT_COMMAND = "codex-cmd";
const POLICY = "policy-digest-wpc";

/** The one `<Session>` element every fixture here places. */
const IDENTITY: AgentSessionIdentity = {
  provider: PROVIDER,
  agentCommand: AGENT_COMMAND,
  sessionIdentity: "expansion:review",
};

/** What this run retains the conversation under. */
const RETAINED = agentSessionKey(IDENTITY);

/**
 * What the provider calls the same session.
 *
 * A different namespace that happens to share a prefix, exactly as the real
 * placement key does. Nothing under test may recover one from the other by
 * taking the spelling apart.
 */
const PLACEMENT = `${RETAINED}:0123456789abcdef`;

/** A session the run never placed, for the Prompt that must retain nothing. */
const FOREIGN_PLACEMENT = "some-other-provider-key";

interface Reply {
  /** What the agent answered. */
  readonly text: string;
  /** Which turn it says that was, or none. */
  readonly turnId?: string;
  /** Which session it answered in. Defaults to the placed one. */
  readonly placement?: string;
  /** Whether the turn succeeded. Defaults to true. */
  readonly failed?: true;
  /** Held here before the turn answers, so a run can be interrupted mid-turn. */
  readonly hold?: () => Operation<void>;
}

function subscriptionOver(
  events: readonly AgentPromptEvent[],
  close: string,
): Stream<AgentPromptEvent, string> {
  return {
    // deno-lint-ignore require-yield
    *[Symbol.iterator]() {
      let index = 0;
      return {
        // deno-lint-ignore require-yield
        *next() {
          const event = events[index];
          if (event === undefined) {
            return { done: true, value: close };
          }
          index += 1;
          return { done: false, value: event };
        },
      };
    },
  };
}

/**
 * A provider that answers each Prompt from a script, in order.
 *
 * It states a checkpoint the only way a provider can: through the authority
 * core delivered to it as it installed. That is the point of driving a factory
 * here rather than assembling events by hand — a checkpoint no authority stated
 * is a checkpoint this run must not retain, and this fixture cannot fake one.
 */
function scriptedProvider(replies: readonly Reply[]): AgentProviderFactory {
  return function* (_options, authority: AgentProviderAuthority): Operation<void> {
    let index = 0;
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]): Operation<string> {
          return name ?? "codex";
        },
        // deno-lint-ignore require-yield
        *session(): Operation<Session> {
          return { sessionKey: PLACEMENT, cwd: "/nowhere" };
        },
        *prompt(): Operation<Stream<AgentPromptEvent, string>> {
          const reply = replies[index];
          index += 1;
          if (reply === undefined) {
            throw new Error("the scripted provider was asked for more turns than it has");
          }
          if (reply.hold !== undefined) {
            yield* reply.hold();
          }
          const session: Session = {
            sessionKey: reply.placement ?? PLACEMENT,
            cwd: "/nowhere",
          };
          const terminal: AgentPromptEvent = reply.failed
            ? { type: "terminal", status: "failed", error: new Error("the turn failed") }
            : { type: "terminal", status: "completed", stopReason: "end_turn" };
          if (reply.turnId !== undefined) {
            authority.checkpoint(terminal, {
              provider: "codex",
              kind: "app-server-turn-id",
              value: reply.turnId,
            });
          }
          return subscriptionOver(
            [
              { type: "started", agent: "codex", session },
              { type: "text_delta", text: reply.text },
              terminal,
            ],
            reply.text,
          );
        },
        // deno-lint-ignore require-yield
        *launch(): Operation<void> {
          throw new Error("this fixture routes no launch");
        },
      },
      { at: "min" },
    );
  };
}

/** Commit the session mapping the associations reference. */
function* retainSession(database: WorkflowRunDatabase): Operation<void> {
  const committed = yield* transactAgentSessions(database, function* (sessions) {
    sessions.commit({
      sessionKey: RETAINED,
      ...IDENTITY,
      policy: POLICY,
      assertion: { kind: "acpx.agentSessionId", value: "agent-session:alpha" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
  if (!committed.ok) {
    throw committed.error;
  }
}

interface Attempt {
  output?: Json;
  failure?: string;
  events: DurableEvent[];
}

/**
 * Run one document against this run's journal, with the publisher installed.
 *
 * `placed` is what the placement recorded, supplied the way the real
 * attachment supplies it — a lookup of what this host placed, never a parse of
 * the provider's own key.
 */
function runDocument(
  database: WorkflowRunDatabase,
  source: string,
  replies: readonly Reply[],
  placed: readonly string[] = [PLACEMENT],
): Operation<Attempt> {
  return scoped(function* () {
    yield* useAgentPromptPublisher(
      createWorkflowPromptPublisher({
        database,
        retainedSessionKey: (key) => (placed.includes(key) ? RETAINED : undefined),
      }),
    );
    const factory = scriptedProvider(replies);
    yield* installAgentComponents({
      defaultAgent: "codex",
      permissionMode: "deny-all",
      rootProvider: {
        factory,
        options: { defaultAgent: "codex", permissionMode: "deny-all" },
      },
    });

    let output: Json | undefined;
    let failure: string | undefined;
    try {
      output = yield* collect(
        yield* executeInstalled({ ...inlineSource(source), stream: database.journal }, [
          // `<Session>` names durable work after its own invocation, so the
          // host declares it and canonical execution builds it from the
          // claimant it minted for this execution.
          { components: agentIdentityComponents() },
        ]),
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

/** Every `agent_prompt` event this run retained, in journal order. */
function prompts(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "agent_prompt",
  );
}

function* associations(database: WorkflowRunDatabase): Operation<AgentPromptCheckpointRecord[]> {
  const read = yield* transactAgentPromptCheckpoints(database, function* (checkpoints) {
    return checkpoints.readAll();
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/** One row of the run's journal, as another connection can see it. */
interface CommittedEvent {
  readonly eventId: string;
  readonly workspaceRootId: string;
  readonly name: string;
}

function committedPrompts(path: string): CommittedEvent[] {
  const database = new DatabaseSync(path);
  try {
    return database
      .prepare("SELECT event_id, record, workspace_root_id FROM journal_events ORDER BY sequence")
      .all()
      .flatMap((row) => {
        const record = String(row["record"]);
        if (!record.includes('"type":"agent_prompt"')) {
          return [];
        }
        const parsed: unknown = JSON.parse(record);
        const description = Reflect.get(Object(parsed), "description");
        return [
          {
            eventId: String(row["event_id"]),
            workspaceRootId: String(row["workspace_root_id"]),
            name: String(Reflect.get(Object(description), "name")),
          },
        ];
      });
  } finally {
    database.close();
  }
}

/** What the run's Workspace is currently on, read from outside. */
function currentRoot(path: string): string {
  const database = new DatabaseSync(path);
  try {
    const row = database
      .prepare("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1")
      .get();
    return String(row?.["current_root_id"]);
  } finally {
    database.close();
  }
}

/** Every association the file holds, read from outside, in journal order. */
function committedAssociations(path: string): Record<string, unknown>[] {
  const database = new DatabaseSync(path);
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get("agent_prompt_checkpoints");
    if (table === undefined) {
      return [];
    }
    return database
      .prepare(
        `SELECT c.* FROM agent_prompt_checkpoints c
         JOIN journal_events e ON e.event_id = c.event_id
         ORDER BY e.sequence`,
      )
      .all();
  } finally {
    database.close();
  }
}

/** Everything this file declares, so a schema can be compared without its rows. */
function declaredSchema(path: string): Record<string, unknown>[] {
  const database = new DatabaseSync(path);
  try {
    return database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  } finally {
    database.close();
  }
}

/** Whether the file declares the optional table at all. */
function hasTable(path: string): boolean {
  const database = new DatabaseSync(path);
  try {
    return (
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("agent_prompt_checkpoints") !== undefined
    );
  } finally {
    database.close();
  }
}

/**
 * Make the association insert fail inside SQLite, after the Prompt is appended.
 *
 * A trigger rather than a stub: the failure has to come from the database with
 * the Prompt's own row already written in this transaction, because that is the
 * only arrangement where a half-committed publication would show.
 */
function refuseAssociation(path: string): void {
  tamper(path, (database) => {
    database.exec(`
      CREATE TRIGGER refuse_association BEFORE INSERT ON agent_prompt_checkpoints
      BEGIN
        SELECT raise(ABORT, 'the run refuses this association');
      END
    `);
  });
}

/** Make every `agent_prompt` append fail inside SQLite. */
function refuseAgentPromptAppend(path: string): void {
  tamper(path, (database) => {
    database.exec(`
      CREATE TRIGGER refuse_agent_prompt BEFORE INSERT ON journal_events
      WHEN NEW.record LIKE '%"type":"agent_prompt"%'
      BEGIN
        SELECT raise(ABORT, 'the journal refuses this row');
      END
    `);
  });
}

/** Take the optional table away, leaving the exact pre-#622 version-1 shape. */
function makeLegacy(path: string): void {
  tamper(path, (database) => {
    database.exec("DROP TABLE agent_prompt_checkpoints");
  });
}

const ONE_PROMPT = `# Review

<Session name="review">
  <Prompt>look at the change</Prompt>
</Session>
`;

const THREE_PROMPTS = `# Review

<Session name="review">
  <Prompt>same question</Prompt>
  <Prompt>same question</Prompt>
  <Prompt>same question</Prompt>
</Session>
`;

describe("Tier WPC — retained Prompt checkpoints", () => {
  it("WPC1: one commit holds the Prompt, its Workspace root, the session and the token", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);
      const before = committedEventCount(path);

      const attempt = yield* runDocument(database, ONE_PROMPT, [
        { text: "looks fine", turnId: "turn-alpha" },
      ]);

      expect(attempt.failure).toBe(undefined);
      expect(prompts(attempt.events)).toHaveLength(1);
      expect(committedEventCount(path)).toBeGreaterThan(before);

      const [event] = committedPrompts(path);
      expect(event).toBeDefined();
      // The association names the exact event this append produced, and that
      // event carries the root the run was on when it was written. Neither is
      // a lookup of what happens to be last.
      expect(event!.workspaceRootId).toBe(currentRoot(path));
      expect(yield* associations(database)).toEqual([
        {
          eventId: event!.eventId,
          sessionKey: RETAINED,
          provider: "codex",
          tokenKind: "app-server-turn-id",
          tokenValue: "turn-alpha",
        },
      ]);
    });
  });

  it("WPC2: the retained session key is the run's, not the provider's", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);

      yield* runDocument(database, ONE_PROMPT, [{ text: "ok", turnId: "turn-alpha" }]);

      const [row] = committedAssociations(path);
      // The two keys share a prefix and are different things. A row carrying
      // the provider's key would satisfy every shape check here and reference
      // a session this run does not retain.
      expect(row?.["session_key"]).toBe(RETAINED);
      expect(row?.["session_key"]).not.toBe(PLACEMENT);
    });
  });

  it("WPC3: a refused association takes the Prompt's own event with it", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);
      refuseAssociation(path);

      const attempt = yield* runDocument(database, ONE_PROMPT, [
        { text: "ok", turnId: "turn-alpha" },
      ]);

      // The failure that matters is not that the document failed: it is that
      // the journal never gained the Prompt whose association was refused. The
      // run's own events around it are its history and stay where they are.
      expect(attempt.failure).toBeDefined();
      // The planted fault must be the one that fired: a refusal from somewhere
      // else would prove nothing about what an association rollback takes with it.
      expect(attempt.failure).toContain("the run refuses this association");
      expect(committedPrompts(path)).toEqual([]);
      expect(committedAssociations(path)).toEqual([]);
    });
  });

  it("WPC4: a refused Prompt append retains no association either", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);
      refuseAgentPromptAppend(path);

      const attempt = yield* runDocument(database, ONE_PROMPT, [
        { text: "ok", turnId: "turn-alpha" },
      ]);

      expect(attempt.failure).toBeDefined();
      expect(attempt.failure).toContain("Failed to persist durable yield event");
      expect(committedPrompts(path)).toEqual([]);
      expect(committedAssociations(path)).toEqual([]);
    });
  });

  it("WPC5: an unsuccessful turn is published and names no turn", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);

      yield* runDocument(database, ONE_PROMPT, [
        { text: "partial", turnId: "turn-alpha", failed: true },
      ]);

      // Published, because the run had the turn and its failure is history. Not
      // associated, because there is no point in a failed turn to continue from
      // — whatever the adapter went on to call it.
      expect(committedPrompts(path)).toHaveLength(1);
      expect(committedAssociations(path)).toEqual([]);
    });
  });

  it("WPC6: a session this run did not place retains nothing", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);

      yield* runDocument(
        database,
        ONE_PROMPT,
        [{ text: "ok", turnId: "turn-alpha", placement: FOREIGN_PLACEMENT }],
        [PLACEMENT],
      );

      expect(committedPrompts(path)).toHaveLength(1);
      expect(committedAssociations(path)).toEqual([]);
    });
  });

  it("WPC7: identical text with a missing middle token leaves that Prompt unassociated", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);

      // Three indistinguishable turns. The middle one names nothing, and the
      // tokens either side are not consecutive, so nothing about the text, the
      // order, or the neighbours can be used to guess what it was.
      yield* runDocument(database, THREE_PROMPTS, [
        { text: "same answer", turnId: "turn-1" },
        { text: "same answer" },
        { text: "same answer", turnId: "turn-9" },
      ]);

      const events = committedPrompts(path);
      expect(events).toHaveLength(3);
      const rows = committedAssociations(path);
      expect(rows.map((row) => row["token_value"])).toEqual(["turn-1", "turn-9"]);
      // The gap stays a gap, and it is the middle Prompt's. A run that filled
      // it from repeated text, from journal order, or from a neighbour would
      // continue from a turn nobody named.
      expect(rows.map((row) => row["event_id"])).toEqual([events[0]!.eventId, events[2]!.eventId]);
    });
  });

  it("WPC8: replay returns the stored results, contacts no provider and adds nothing", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);
      const live = yield* runDocument(database, ONE_PROMPT, [
        { text: "looks fine", turnId: "turn-alpha" },
      ]);
      const beforeEvents = committedEventCount(path);
      const beforeRows = committedAssociations(path);

      // No replies at all: the scripted provider raises if anything asks it for
      // a turn, so a replay that contacted it fails rather than passing quietly.
      const replayed = yield* runDocument(database, ONE_PROMPT, []);

      expect(replayed.failure).toBe(undefined);
      expect(replayed.output).toEqual(live.output);
      expect(committedEventCount(path)).toBe(beforeEvents);
      expect(committedAssociations(path)).toEqual(beforeRows);
    });
  });

  it("WPC9: a partial replay resumes without re-associating what it restored", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);

      // The first attempt is interrupted inside its third turn, so two Prompts
      // are retained and the third was never journaled at all — which is the
      // history a continuation actually meets.
      const reached = withResolvers<void>();
      const attempt = yield* spawn(() =>
        runDocument(database, THREE_PROMPTS, [
          { text: "one", turnId: "turn-1" },
          { text: "two", turnId: "turn-2" },
          {
            text: "three",
            turnId: "turn-3",
            *hold(): Operation<void> {
              reached.resolve();
              yield* suspend();
            },
          },
        ]),
      );
      yield* reached.operation;
      yield* attempt.halt();
      expect(committedPrompts(path)).toHaveLength(2);

      // The continuation supplies only the turn that never ran. Two replies
      // would mean the restored Prompts had gone back to the provider.
      const second = yield* runDocument(database, THREE_PROMPTS, [
        { text: "three", turnId: "turn-3" },
      ]);

      expect(second.failure).toBe(undefined);
      const rows = committedAssociations(path);
      expect(rows.map((row) => row["token_value"])).toEqual(["turn-1", "turn-2", "turn-3"]);
    });
  });

  it("WPC10: a legacy version-1 run replays without gaining the table", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    let before: Uint8Array;
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);
      yield* runDocument(database, ONE_PROMPT, [{ text: "looks fine" }]);
    });

    // An exact pre-#622 version-1 database: this run never had an association,
    // so taking the table away leaves the file a build before #622 would have
    // written.
    makeLegacy(path);
    expect(hasTable(path)).toBe(false);
    before = yield* until(readFile(path));

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const replayed = yield* runDocument(database, ONE_PROMPT, []);
      expect(replayed.failure).toBe(undefined);
      // Read through the run's own reader, which must answer for a file that
      // holds no table rather than refusing it.
      expect(yield* associations(database)).toEqual([]);
    });

    // Byte-identical: reading a legacy run creates nothing, migrates nothing,
    // and synthesizes no association for the Prompt it already holds.
    expect(yield* until(readFile(path))).toEqual(before);
    expect(hasTable(path)).toBe(false);
  });

  it("WPC11: a legacy run gains the table only when it first has something to put in it", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* retainSession(database);
    });
    makeLegacy(path);
    expect(hasTable(path)).toBe(false);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, ONE_PROMPT, [{ text: "ok", turnId: "turn-alpha" }]);
    });

    expect(hasTable(path)).toBe(true);
    expect(committedAssociations(path).map((row) => row["token_value"])).toEqual(["turn-alpha"]);
  });

  it("WPC12: a rollback on a legacy run leaves the exact legacy schema", function* () {
    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      yield* createRun();
    });
    // A legacy run that retained no session either, so the association's
    // foreign key is what fails. The fault comes from the table's own
    // constraint rather than from anything added to the schema to cause it.
    makeLegacy(path);
    const before = declaredSchema(path);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const attempt = yield* runDocument(database, ONE_PROMPT, [
        { text: "ok", turnId: "turn-alpha" },
      ]);
      expect(attempt.failure).toBeDefined();
      // The association's own foreign key, not something else on the way there.
      expect(attempt.failure).toContain("FOREIGN KEY constraint failed");
    });

    // The table was created inside the transaction that failed, so it goes with
    // it. What is left is the exact schema that was there before — not a
    // version-1 file carrying an empty table nobody asked for. The run's own
    // events around the refusal are its history and stay where they are, which
    // is why this compares declarations rather than bytes.
    expect(hasTable(path)).toBe(false);
    expect(declaredSchema(path)).toEqual(before);
    expect(committedPrompts(path)).toEqual([]);
  });
});

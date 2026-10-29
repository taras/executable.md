/**
 * One phase of a recovery case, as its own process.
 *
 * R2 is about what survives a process ending, so its phases have to *be*
 * processes. A second Effection scope in the same test proves that a new host
 * reads what an old one wrote; it cannot prove anything about module state,
 * caches, open handles or anything else a real restart discards, and the
 * handoff asks for the restart.
 *
 * So each phase runs here, launched by the test under whichever runtime the
 * suite is running on. Only two things cross the boundary: the files under the
 * data root, and the arguments on the command line. Nothing is shared, and
 * there is no clock anywhere in it — the test synchronizes on this process
 * exiting, which is an observed boundary rather than a guess about timing.
 *
 * What comes back is one JSON line on stdout. A phase that refuses says so in
 * that line and still exits 0: "the publication refused" is this phase's
 * *result*, and a nonzero exit would make it indistinguishable from the phase
 * having crashed before it got there.
 */

import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { main, Ok, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { AGENT_PROMPT, parsePromptRecord } from "@executablemd/core/host";

import { installReplHost } from "../../../../src/repl-assembly.ts";
import { REPL_DIRECTORY } from "../../../../src/repl/storage.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  parseSidekickRecord,
  publishPair,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../../../../src/repl/sidekick/history.ts";
import type { SidekickRecord } from "../../../../src/repl/sidekick/history.ts";
import { ROOT_IMPORT } from "../../../../src/repl/entries.ts";
import { pairedReplRepository } from "../../../../src/repl/sidekick/repository.ts";
import { bindRetainedPrefix } from "../../../../src/repl/sidekick/history.ts";
import {
  admitting,
  coldReservation,
  controlJournal,
  retainResolution,
  submitForSidekick,
} from "../../../../src/repl/sidekick/admission.ts";
import { openReplSession } from "../../../../src/repl/session.ts";
import type { ReplSession } from "../../../../src/repl/session.ts";
import { Elicitation, useTempFileCompiler } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { pairedLocation } from "../../../../src/repl/sidekick/history.ts";
import { encodeLocation } from "../../../../src/repl/route.ts";
import { initialState } from "../../../../src/repl/application.ts";
import { resolveAgentStack } from "../../../../src/agent-stack.ts";
import { assembleReplProfile } from "../../../../src/repl-profile.ts";
import { NO_PLUGINS } from "../../../../src/plugin-host.ts";
import { rootReads } from "../../../../src/repl/sidekick/requests.ts";
import { useSidekickOwner } from "../../../../src/repl/sidekick/owner.ts";
import type { SidekickAssembly, SidekickOwner } from "../../../../src/repl/sidekick/owner.ts";
import type { SubmitReceipt } from "../../../../src/repl/sidekick/controls.ts";
import type { PairedChatStorage } from "../../../../src/repl/sidekick/repository.ts";
import { createFakeAcp, makeRegistry } from "../../../support/fake-acp.ts";
import { createAcpxProvider, createAcpxSessionStore, retainedSession } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { installAgentComponents } from "@executablemd/core";
import type { FakeAcp } from "../../../support/fake-acp.ts";

/** The conversation and response a reply's control belongs to. */
const CHAT = "chat-1";
const RESPONSE = "r1";
const AGENT = "stub";

/** What the reply asks to be admitted. No components, so the preflight passes. */
const SOURCE = "Reserved body.\n";

/**
 * The conversation, turn and reply a reply's Submit sits inside.
 *
 * Written to the shapes the protocol defines rather than to anything convenient:
 * the retained Prompt event is what says the turn completed, and the response
 * record is what says a reply rendered. A Submit intent belongs to one of those.
 */
function conversationWithReply(): SidekickRecord[] {
  const prompt: DurableEvent = {
    type: "yield",
    coroutineId: "root",
    description: { type: "agent_prompt", name: "turn:1", input: "ask" },
    result: {
      status: "ok",
      value: {
        sequence: 0,
        agent: AGENT,
        sessionKey: "stub:default",
        status: "completed",
        text: "working on it",
      },
    },
  } as unknown as DurableEvent;
  return [
    { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "prepared" },
    { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "activated" },
    { kind: "event", conversation: CHAT, sequence: 0, event: serializeDurableEvent(prompt) },
    {
      kind: "response",
      conversation: CHAT,
      turn: 1,
      response: RESPONSE,
      outcome: { status: "ok" },
      hasOutput: true,
      output: "working on it",
    },
  ];
}

/** One ordinary entry record, as a run writes one. */
function event(value: string): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "test_effect", name: value, input: null },
    result: { status: "ok", value },
  } as unknown as DurableEvent;
}

/** Every path this process appended to, so a phase can report that it wrote nothing. */
const appended: string[] = [];

/**
 * Whether this phase interrupts the publication, and where.
 *
 * `ready` is the last of a publication's four writes, so failing it leaves
 * every earlier one done — the exact boundary the storage contract names,
 * reached by the production code rather than simulated by writing files.
 */
let interruptAt: string | undefined;

/**
 * Where this phase stops being a process, and a latch that says it has.
 *
 * Different from `interruptAt`, and the difference is the whole of cases 3 and
 * 4. A refused append is a failure the code above it *handles* — it writes the
 * outcome saying so, which is the correct thing to do and the opposite of what
 * these cases need. What they need is the process ending between two writes, so
 * this suspends the append instead: the record is never written, nothing after
 * it runs, and the phase returns and lets the scope unwind through all of it.
 * No clock and no signal: the latch is the observed boundary.
 */
let holdAt: string | undefined;
/** The same stop, chosen by predicate rather than by substring. */
let holdWhen: ((record: string) => boolean) | undefined;
/** The exact record the hold is sitting on, so a case can identify it. */
let holding: string | undefined;
const reached = withResolvers<void>();

function* useHost(dataRoot: string): Operation<void> {
  yield* installReplHost({
    dataRoot: () => dataRoot,
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: async (path, record) => {
      if (holdWhen?.(record) === true) {
        holding = record;
        reached.resolve();
        await new Promise(() => {});
      }
      if (holdAt !== undefined && record.includes(holdAt)) {
        reached.resolve();
        // Suspends rather than resolves or throws: this write never happens and
        // neither does anything waiting on it, which is what a process ending
        // here leaves behind.
        await new Promise(() => {});
      }
      if (interruptAt !== undefined && record.includes(interruptAt)) {
        throw new Error("this process stopped before it could finish publishing");
      }
      await appendFile(path, record);
      appended.push(path);
    },
  });
}

/**
 * Where a conversation phase stops, as a predicate on the record being written.
 *
 * A substring is not enough for these boundaries. Case 6's stop is the *second*
 * feedback record of a response — the one that names the turn that accepted it
 * — and the first one is written before the turn and matches any substring the
 * second does. So a boundary is a predicate, and the interesting ones are about
 * which record of a kind this is rather than what kind it is.
 */
const boundaries: Record<string, (record: string) => boolean> = {
  // The *second* canonical Prompt, which in a feedback exchange is the turn
  // that carried the delivery. Holding it leaves an offer with no turn to
  // establish it, while the provider may well have accepted one — which is the
  // state nothing may guess at.
  laterTurn: (() => {
    let seen = 0;
    return (record: string) => record.includes('"type\\":\\"agent_prompt') && ++seen === 2;
  })(),
  // The canonical Prompt. Held, the provider has accepted the turn and asserted
  // the conversation it ran in, and the history that would have acknowledged
  // that mapping is never written.
  turn: (record) => record.includes('"type\\":\\"agent_prompt'),
  // The delivery marker that names its turn. The claim-nothing marker before
  // the turn has `"turn":null`, so this is the one that asserts acceptance.
  delivered: (record) => record.includes('"kind":"feedback"') && !record.includes('"turn":null'),
};

/** What a conversation phase scripts its agent to do. */
interface Script {
  /** One reply per turn, in order. */
  readonly replies: readonly string[];
  /** Where this process stops, by boundary name, or nowhere. */
  readonly stop?: string;
  /** Wait for a question to be pending and then stop, for an interrupted ask. */
  readonly stopAtQuestion?: boolean;
  /** Send this message rather than the default. */
  readonly say?: string;
  /** The native conversation identity this agent reports, when a case pins one. */
  readonly identity?: string;
  /**
   * Start this process with no provider account of earlier sessions.
   *
   * ACPX's store is cache-like and a host may prune it, so a conversation whose
   * history has an established identity can meet a provider that has none. The
   * provider then names the conversation only once the turn has started, which
   * is the *late* assertion — a different path from one it can report while the
   * session is being placed.
   */
  readonly forget?: boolean;
  /**
   * Assemble this process's Sidekick with a system prompt of its own.
   *
   * The ordinary constructor customizes nothing, which is what the saved
   * configuration records as `null`. A process that states a replacement is a
   * host assembled differently — through the same installation path, with every
   * other input identical — which is the one controlled difference a reopening
   * case needs and a change this build cannot apply to a conversation that
   * already exists.
   */
  readonly systemPrompt?: string;
}

/** The pieces one conversation phase runs over, assembled the way a command does. */
interface Conversing {
  readonly owner: SidekickOwner;
  readonly fake: FakeAcp;
  readonly chat: PairedChatStorage;
  /** The draft a reply filled, which is this process's own state. */
  draft(): string;
  /**
   * What the provider's own store retains for a session key, read back.
   *
   * The provider's account, not this CLI's: a case about an acknowledgement
   * that never landed has to be able to show that the assertion it is missing
   * does exist somewhere, and this is the only somewhere there is.
   */
  retained(sessionKey: string): Operation<{ readonly agentSessionId?: string } | undefined>;
}

/**
 * The real Sidekick, over a real published pair, in this process.
 *
 * The same assembly order the command uses — host, repository, profile (which
 * installs the provider), session, owner — because R2's cases are about what a
 * *process* leaves behind, and a fixture that stood in for any of those layers
 * would be reporting its own bookkeeping. What is scripted is the agent, which
 * is where the transport facts a case controls belong.
 */
function* useConversing(
  dataRoot: string,
  execution: string,
  script: Script,
): Operation<Conversing> {
  yield* useTempFileCompiler();
  yield* useHost(dataRoot);
  const repository = repositoryOf(dataRoot);
  const pair = yield* pairedReplRepository(repository).open(execution);
  if (pair.chat.form !== "paired") {
    throw new Error("a conversation case needs a published pair");
  }
  const chat = pair.chat as PairedChatStorage;
  const fake = createFakeAcp();
  if (script.identity !== undefined) {
    fake.identity(script.identity);
  }
  for (const reply of script.replies) {
    fake.script({ reply });
  }
  const stack = yield* resolveAgentStack(
    {
      agentProvider: "acpx",
      defaultAgent: AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: false,
    },
    undefined,
  );
  if (!stack.ok) {
    throw stack.error;
  }
  // The canonical store, on disk under this case's own data root, and one of
  // it per process the way production has one. An in-memory store is allocated
  // fresh in every process, so the provider's account of which native
  // conversation it created would die with the process that created it — and a
  // case about reconciling an assertion across a restart would be reconciling
  // nothing but the fixture's own determinism.
  // Created before the store is built: the runtime's save is fire-and-forget
  // at the acpx boundary, so a write into a directory that is not there is a
  // record that silently never lands.
  const state = join(dataRoot, "acpx");
  if (script.forget === true) {
    yield* until(rm(state, { recursive: true, force: true }));
  }
  yield* until(mkdir(state, { recursive: true }));
  const store = createAcpxSessionStore(state);
  const profile = yield* (yield* assembleReplProfile(stack.value, NO_PLUGINS, {
    acp: {
      createRuntime: fake.create,
      sessionStore: store,
      agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
    },
    // The scripted agent, named to the profile rather than left to the
    // environment: the Sidekick assembly is built with it, and a conversation
    // opened under an agent this registry does not know would fail as an
    // availability refusal rather than reaching the fake.
    sidekickAgent: AGENT,
    planWriterRoot: repository,
  })).finalize();
  const opened = yield* openReplSession({
    execution: pair,
    includes: profile.includes,
    installations: profile.installations,
    permissionMode: profile.permissionMode,
  });
  if (!opened.ok) {
    throw opened.error;
  }
  const live = opened.value;
  let draft = "";
  const owner = yield* useSidekickOwner({
    // The production assembly this profile built, from the same disk-backed
    // store and scripted runtime: one construction, used by every phase, so a
    // conversation created in one process is reopened under what actually
    // created it.
    // Ordinarily the assembly the profile built; for a case that states a
    // system prompt, the same installation path with that one input replaced.
    assembly:
      script.systemPrompt === undefined
        ? profile.sidekickAssembly
        : differingAssembly(script.systemPrompt, {
            createRuntime: fake.create,
            sessionStore: store,
            agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
          }),
    chat,
    // deno-lint-ignore require-yield
    *establish(): Operation<Result<PairedChatStorage>> {
      return Ok(chat);
    },
    root: {
      ...rootReads(live, profile),
      // deno-lint-ignore require-yield
      *fill(source: string): Operation<Result<void>> {
        draft = source;
        return Ok(undefined);
      },
    },
    // deno-lint-ignore require-yield
    *submit(): Operation<Result<SubmitReceipt>> {
      throw new Error("these cases submit nothing — cases 3 and 4 own the reservation");
    },
    revision: () => 0,
    // deno-lint-ignore require-yield
    *acknowledge(): Operation<void> {
      // These rows hold their own state directly rather than through the
      // screen's loop, so a saved message needs nothing applied for it.
    },
    draft: () => draft,
  });
  return {
    owner,
    fake,
    chat,
    draft: () => draft,
    retained: (sessionKey) => retainedSession(store, sessionKey),
  };
}

/**
 * Every canonical turn this history holds, as the journal holds it.
 *
 * Read through Core's own Prompt reader rather than off a record of this CLI's
 * own, because what a turn was sent and which conversation it ran in are
 * canonical facts — and they are what a delivery or an identity is reconciled
 * against when this CLI's own marker is missing.
 */
function turnsOf(records: readonly SidekickRecord[]): Record<string, unknown>[] {
  const held: Record<string, unknown>[] = [];
  for (const record of records) {
    if (record.kind !== "event") {
      continue;
    }
    const read = parseDurableEvent(record.event);
    if (!read.ok) {
      continue;
    }
    const event = read.value;
    if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
      continue;
    }
    const parsed = event.result.status === "ok" ? parsePromptRecord(event.result.value) : undefined;
    held.push({
      name: event.description.name,
      durable: event.result.status,
      input: (event.description as { input?: unknown }).input ?? null,
      status: parsed?.status ?? null,
      conversation: parsed?.agentSessionId ?? null,
    });
  }
  return held;
}

/** What a conversation phase reports about the history it is looking at. */
function* readingOf(owner: SidekickOwner): Operation<Record<string, unknown>> {
  const held = owner.reading;
  if (!held.ok) {
    return { readable: false, refused: held.error.message };
  }
  const value = held.value;
  return {
    readable: true,
    active: value.active ?? null,
    // The message ID beside the turn recorded for that message's request, both
    // as the production reading gives them. Neither is worked out here: a
    // harness that computed the association would be checking itself.
    chat: value.chat.map((item) => ({
      kind: item.kind,
      ...(item.kind === "person" ? { message: item.message } : {}),
      turn: item.turn,
      // A saved turn with no evaluated reply has no body: what it says about
      // itself is its own inert status, reported as that rather than as text
      // borrowed from somewhere else.
      text: item.kind === "saved" ? item.status : item.text,
    })),
    conversations: value.conversations.map((one) => ({
      id: one.id,
      agent: one.agent,
      phase: one.phase,
      attempted: one.attempted,
      completed: one.completed,
      // What this conversation's agent has actually been given, by digest, as
      // the production reading establishes it.
      oriented: one.oriented === undefined ? null : Object.keys(one.oriented).sort(),
    })),
    operations: value.operations.map((one) => ({
      response: one.response,
      order: one.order,
      component: one.component,
      status: one.status,
    })),
    unfinished: value.unfinished.map((one) => [one.component, one.status]),
    delivered: value.delivered,
    unestablished: value.unestablished,
    submit: value.submit === undefined ? null : value.submit.entry,
  };
}

/**
 * What the record this phase stopped on actually is.
 *
 * Reported rather than assumed: a boundary named by a predicate has to be shown
 * to be the record the case means, or the row proves only that *something* was
 * held.
 */
function describeHeld(): Record<string, unknown> | null {
  if (holding === undefined) {
    return null;
  }
  const parsed = parseSidekickRecord(holding);
  if (parsed === undefined) {
    return { kind: "unreadable" };
  }
  if (parsed.kind !== "event") {
    return { kind: parsed.kind };
  }
  const event = parseDurableEvent(parsed.event);
  if (!event.ok || event.value.type !== "yield") {
    return { kind: "event" };
  }
  return {
    kind: "event",
    durable: event.value.description.type,
    name: event.value.description.name,
    status: event.value.result.status,
  };
}

/**
 * The durable record each mirrored event is, in the order the chat holds them.
 *
 * Read, never written. A row that wanted to know the conversation's own
 * configuration is already saved asks the history for it rather than being
 * handed a record this fixture made up.
 */
function durablesOf(records: readonly SidekickRecord[]): string[] {
  const held: string[] = [];
  for (const record of records) {
    if (record.kind !== "event") {
      continue;
    }
    const event = parseDurableEvent(record.event);
    if (event.ok && event.value.type === "yield") {
      held.push(event.value.description.type);
    }
  }
  return held;
}

/**
 * The Sidekick assembly a differently configured host would build.
 *
 * The production path, with one input replaced: the same factory, the same
 * explicit empty tool and server lists, the same strict routing and denied
 * permissions, and a system prompt this host states instead of leaving the
 * agent's own in place. It adds no option to the command and no supported way
 * to change a conversation — it is a second host, which is exactly what a
 * reopening has to be able to refuse.
 */
function differingAssembly(
  systemPrompt: string,
  dependencies: AcpxProviderDependencies,
): SidekickAssembly {
  const options = { defaultAgent: AGENT, permissionMode: "deny-all" as const };
  const factory = createAcpxProvider({
    ...dependencies,
    permissions: "strict",
    mcpServers: [],
    newSessionOptions: { allowedTools: [], systemPrompt },
  });
  return {
    agent: AGENT,
    installations: [
      {
        *install(): Operation<void> {
          yield* installAgentComponents({
            defaultAgent: AGENT,
            permissionMode: "deny-all",
            rootProvider: { factory, options },
          });
        },
      },
    ],
  };
}

/** Wait for this Sidekick to be waiting on a question. Nothing is slept on. */
function* questioned(owner: SidekickOwner): Operation<void> {
  if (owner.questions.pending !== undefined) {
    return;
  }
  const changes = yield* owner.questions.changes;
  while (true) {
    const next = yield* changes.next();
    if (next.done === true) {
      throw new Error("the question stream ended before one was asked");
    }
    if (owner.questions.pending !== undefined) {
      return;
    }
  }
}

function repositoryOf(dataRoot: string): string {
  return join(dataRoot, ...REPL_DIRECTORY);
}

function* phases(): Operation<unknown> {
  const [phase, dataRoot, execution, extra] = process.argv.slice(2);
  if (phase === undefined || dataRoot === undefined || execution === undefined) {
    throw new Error("a phase needs a name, a data root and an execution");
  }
  const repository = repositoryOf(dataRoot);
  const legacy = join(repository, `${execution}.jsonl`);
  const sidekick = join(repository, PAIRED_DIRECTORY, execution, SIDEKICK_FILE);
  const entries = join(repository, PAIRED_DIRECTORY, execution, ENTRIES_FILE);

  if (phase === "workspace-start" || phase === "workspace-continue") {
    const mounted = yield* until(import("../../../support/mounted-repl.ts"));
    const { useReplPage } = yield* until(import("../../../support/mounted-page.ts"));
    const adapters = yield* until(import("../../../support/repl-page-adapters.ts"));
    const { denoReplEntry } = yield* until(import("../../../../src/deno-repositories.ts"));
    const project = join(dataRoot, "project");
    yield* until(mkdir(project, { recursive: true }));
    const live = { reads: 0, writes: 0, deletes: 0, ensures: 0 };
    if (phase === "workspace-continue") {
      yield* Elicitation.around({
        *elicit() {
          return { go: "yes" };
        },
      });
    }
    const entryHost = denoReplEntry(
      { runtime: "source", platform: "unix", execPath: "/nonexistent/xmd" },
      join(dataRoot, "managed"),
    );
    const page = yield* useReplPage({
      dataRoot,
      projectCwd: project,
      hostFiles: true,
      *entryInstallation(owner, placement) {
        const installation = yield* entryHost(owner, placement);
        if (phase === "workspace-continue") {
          yield* API.Files.around(
            {
              *readTextFile([input], next) {
                if (live.writes === 0) {
                  throw new Error("historical workspace read reached live I/O");
                }
                live.reads += 1;
                return yield* next(input);
              },
              *writeTextFile([input], next) {
                if (input.path !== "suffix.md") {
                  throw new Error("acknowledged workspace write repeated");
                }
                live.writes += 1;
                return yield* next(input);
              },
              *deleteFile() {
                live.deletes += 1;
                throw new Error("acknowledged workspace delete repeated");
              },
              *ensureDirectory() {
                live.ensures += 1;
                throw new Error("acknowledged workspace ensure repeated");
              },
            },
            { at: "min" },
          );
        }
        return installation;
      },
      ...(phase === "workspace-continue"
        ? { location: encodeLocation(initialState(execution).route) }
        : {}),
    });
    const repl = page.repl;
    const id = yield* mounted.mountedExecution(repl);
    const location = pairedLocation(repository, id);
    if (phase === "workspace-start") {
      yield* until(writeFile(join(location.directory, "obsolete.md"), "remove"));
      const source = [
        '<File path="note.md">A</File>',
        '<File path="note.md" as="historical" />',
        "<Dir path=" +
          JSON.stringify(location.directory) +
          '><Dir path="nested">ensured</Dir></Dir>',
        '<File.Delete path="obsolete.md" />',
        '<Elicit schema={{ type: "object", properties: { go: { type: "string" } }, required: ["go"], additionalProperties: false }} as="answer">Continue?</Elicit>',
        "{historical}",
        '<File path="suffix.md">once</File>',
        '<File path="note.md" />',
      ].join("\n");
      repl.fake.script({
        reply:
          '<Let as="code" select="code">\n```xmd\n' +
          source +
          "\n```\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />",
      });
      yield* adapters.sidekick(page).send("perform workspace work and wait");
      yield* page.until("the workspace entry's question", (one) =>
        adapters.shows(one, "waiting for an answer"),
      );
      const read = yield* mounted.mountedReading(repl);
      return {
        execution: id,
        workspace: location.directory,
        source: read.model.entries[0]?.source,
        settled: read.model.entries[0]?.settled,
        records: yield* until(readFile(location.entries, "utf8")),
      };
    }
    // The History rail's own mark for the first entry. `1. [ok] entry-1` is a
    // row of the Entries catalog, which this screen keeps in a drawer — so the
    // settled state is read where the screen states it.
    yield* adapters.entrySettles(page, 1, "ok");
    const read = yield* mounted.mountedReading(repl);
    return {
      execution: id,
      live,
      output: read.model.entries[0]?.terminal?.output,
      source: read.model.entries[0]?.source,
      settled: read.model.entries[0]?.settled,
      note: yield* until(readFile(join(location.directory, "note.md"), "utf8")),
      obsolete: yield* until(readFile(join(location.directory, "obsolete.md"), "utf8")),
      suffix: yield* until(readFile(join(location.directory, "suffix.md"), "utf8")),
      sessions: repl.fake.ensured.length,
      prompts: repl.fake.prompts.length,
    };
  }

  if (phase === "seed") {
    // The older single-file execution this case starts from: the state a
    // previous version of this CLI left behind.
    yield* until(writeFile(legacy, serializeDurableEvent(event("one"))));
    return { seeded: true, bytes: (yield* until(readFile(legacy, "utf8"))).length };
  }

  if (phase === "interrupt" || phase === "publish") {
    interruptAt = phase === "interrupt" ? '"kind":"ready"' : undefined;
    yield* useHost(dataRoot);
    const held = pairedReplRepository(repository);
    try {
      const upgraded = yield* held.upgrade(yield* held.open(execution));
      // The entry that was running carries on through the same facade, past the
      // copy — which is the handoff's whole purpose.
      yield* upgraded.stream.append(event("after"));
      return { published: true, appended: appended.length };
    } catch (error) {
      return {
        published: false,
        refused: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (phase === "read") {
    yield* useHost(dataRoot);
    const held = pairedReplRepository(repository);
    try {
      const opened = yield* held.open(execution);
      return {
        opened: true,
        form: opened.chat.form,
        origin: opened.chat.form === "paired" ? opened.chat.owner.origin : undefined,
        entries: (yield* opened.stream.readAll()).length,
        records: (yield* readSidekickRecords(sidekick)).map((record) => record.kind),
        // Nothing may be appended by opening a history. A reader that wrote
        // would have changed what it was reading.
        appended: appended.length,
      };
    } catch (error) {
      return {
        opened: false,
        refused: error instanceof Error ? error.message : String(error),
        appended: appended.length,
      };
    }
  }

  if (phase === "seed-chat") {
    // A published pair holding a conversation that got as far as one completed
    // turn with a reply. That is the context a reply's control belongs to, and
    // the only part of these cases that is a fixture: section 3 opens no
    // conversation, and a Submit outside one is not a state this grammar has.
    yield* useHost(dataRoot);
    const published = yield* publishPair(repository, execution);
    for (const record of conversationWithReply()) {
      yield* published.sidekick.append(record);
    }
    return { seeded: true, records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind) };
  }

  if (phase === "prior") {
    // One real entry, run through the real session, so what precedes the
    // reservation is a history this CLI actually produced. The source is this
    // phase's argument, which is how two runs of equal length and different
    // content are both genuine.
    if (extra === undefined) {
      throw new Error("the prior phase needs a source");
    }
    yield* useHost(dataRoot);
    const pair = yield* pairedReplRepository(repository).open(execution);
    const opened = yield* openReplSession({ execution: pair });
    if (!opened.ok) {
      throw opened.error;
    }
    const submitted = yield* opened.value.submit(extra);
    if (!submitted.ok) {
      throw submitted.error;
    }
    const outcome = yield* submitted.value.join();
    return {
      ran: outcome.ok,
      entries: opened.value.model.entries.map((entry) => entry.key),
      sources: opened.value.model.entries.map((entry) => entry.source),
      // The record count and the digest of the whole journal, so a case can say
      // two histories are the same length and different records.
      bound: yield* bindRetainedPrefix(entries),
    };
  }

  if (phase === "reserve" || phase === "admit") {
    // Where this process ends. `reserve` stops before the record that admits
    // the entry, so the intent it wrote is the only trace of it; `admit` stops
    // before the receipt, so the entry happened and nothing says how it ended.
    holdAt = phase === "reserve" ? `"name":"${ROOT_IMPORT}"` : '"kind":"control-outcome"';
    yield* useHost(dataRoot);
    const held = pairedReplRepository(repository);
    const pair = yield* held.open(execution);
    if (pair.chat.form !== "paired") {
      throw new Error("this case needs a published pair");
    }
    const opened = yield* openReplSession({ execution: pair });
    if (!opened.ok) {
      throw opened.error;
    }
    const live: ReplSession = opened.value;
    const slot = admitting();
    // The production write path, through the production writer, into the real
    // file. Only the conversation and response this control belongs to come
    // from the history that was seeded — a reply has to be inside one, and
    // nothing in section 3 opens a conversation.
    const journal = controlJournal(pair.chat.writer, { conversation: CHAT, response: RESPONSE });
    yield* spawn(function* (): Operation<void> {
      yield* submitForSidekick(
        { conversation: CHAT, response: RESPONSE },
        {
          session: {
            // The acknowledged history, read the way the root reads it.
            entries: () => {
              const read = live.reading(undefined);
              return read.ok ? Ok(read.value.model.entries) : read;
            },
            admits: () => live.admits(),
            submit: (source) => live.submit(source),
          },
          // A function now, because the root is asked again when the entry
          // actually starts. This phase never edits the draft, so both reads
          // answer the same thing.
          facts: () => ({
            live: true,
            revisions: { draft: 0, message: 0 },
            takenOver: false,
            draft: SOURCE,
          }),
          held: slot,
          journal,
          // The real writer, so the binding waits on the real acknowledgement.
          writer: pair.stream,
          woke: () => {},
        },
      );
    });
    // The boundary, observed. Returning from here unwinds the scope that owns
    // the session, the entry task and that submission, so nothing past the held
    // write ever runs.
    yield* reached.operation;
    return {
      stopped: phase,
      records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind),
    };
  }

  if (phase === "reconcile") {
    yield* useHost(dataRoot);
    const held = pairedReplRepository(repository);
    const pair = yield* held.open(execution);
    if (pair.chat.form !== "paired") {
      throw new Error("this case needs a published pair");
    }
    const opened = yield* openReplSession({ execution: pair });
    if (!opened.ok) {
      return { opened: false, refused: opened.error.message, appended: appended.length };
    }
    const live = opened.value;
    // Cold: the records already on disk and the entries already on disk. This
    // is the whole of what reopening does with an unanswered reservation.
    const cold = yield* coldReservation(pair.chat.records, live.model.entries, entries);
    if (!cold.ok) {
      return {
        opened: true,
        reconciled: false,
        refused: cold.error.message,
        appended: appended.length,
      };
    }
    const found = cold.value;
    const before = appended.length;
    const answer = {
      opened: true,
      reconciled: true,
      finding: found === undefined ? null : found.finding.kind,
      reserved: found === undefined ? null : found.intent.entry,
      source: found === undefined ? null : found.intent.source,
      // Nothing is written by reading. A reopen that appended would have
      // changed the history it was reporting on.
      appendedByOpening: before,
      entries: live.model.entries.map((entry) => entry.key),
      sources: live.model.entries.map((entry) => entry.source),
    };
    if (found === undefined) {
      return answer;
    }
    // The next explicit mutating action retains the finding first. It submits
    // nothing: the source the dead process reserved stays unadmitted.
    yield* retainResolution(pair.chat.writer, found);
    const after = yield* readSidekickRecords(sidekick);
    return {
      ...answer,
      retained: after.map((one) => one.kind),
      // Asked again, of the file as it now stands: the question is answered, so
      // a later reading finds nothing left to reconcile. This is a second
      // projection inside this process, not a further process boundary.
      again: yield* (function* (): Operation<string> {
        const re = yield* coldReservation(after, live.model.entries, entries);
        return re.ok ? (re.value === undefined ? "resolved" : re.value.finding.kind) : "refused";
      })(),
      entriesAfter: live.model.entries.map((entry) => entry.key),
    };
  }

  if (phase === "chat-open") {
    // A published pair with nothing in it. The conversation itself is opened by
    // the production owner in the phases below, not seeded here: cases 2, 5 and
    // 6 are about what that owner leaves behind.
    yield* useHost(dataRoot);
    yield* publishPair(repository, execution);
    return { seeded: true, records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind) };
  }

  if (phase === "chat-say") {
    if (extra === undefined) {
      throw new Error("a conversation phase needs its script");
    }
    const script = JSON.parse(extra) as Script;
    holdWhen = script.stop === undefined ? undefined : boundaries[script.stop];
    if (script.stop !== undefined && holdWhen === undefined) {
      throw new Error(`there is no boundary "${script.stop}"`);
    }
    const held = yield* useConversing(dataRoot, execution, script);
    const said = script.say ?? "do something";
    if (script.stopAtQuestion === true) {
      // The process ends while a question is pending. Nothing is held in the
      // writer: the response is genuinely waiting for an answer nobody will
      // give, which is what an interrupted ask is — so the latch is the
      // question's own arrival, and returning unwinds the response under it.
      yield* spawn(function* (): Operation<void> {
        yield* held.owner.message(said);
      });
      yield* questioned(held.owner);
      return {
        stopped: "question",
        pending: held.owner.questions.pending?.message ?? null,
        records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind),
      };
    }
    if (holdWhen !== undefined) {
      yield* spawn(function* (): Operation<void> {
        yield* held.owner.message(said);
      });
      // The boundary, observed. Returning unwinds the owner, the conversation
      // and the turn under the write that never happened.
      yield* reached.operation;
      // Observed while the acknowledgement is still held: the provider took the
      // turn, and its own store already retains the native conversation it
      // created for it. Both are facts about the world this process is about to
      // stop leaving a record of.
      const conversationKeys = held.fake.ensured
        .map((one) => one.sessionKey)
        .filter((key) => !key.startsWith("xmd:inspect:"));
      // The provider saves its account at the acpx boundary without waiting for
      // it, so the write is observed landing before it is read. Without this the
      // read races the save and reports an assertion that is about to exist.
      yield* held.fake.assertedSessions(1);
      const asserted: (string | undefined)[] = [];
      for (const key of conversationKeys) {
        asserted.push((yield* held.retained(key))?.agentSessionId);
      }
      // The provider saves its account at the acpx boundary without waiting for
      // it, so the write is observed landing before it is read. Without this the
      // read races the save and reports an assertion that is about to exist.
      return {
        stopped: script.stop,
        held: describeHeld(),
        sessions: conversationKeys,
        // The provider's durable assertion, read out of its own store.
        asserted,
        accepted: held.fake.prompts.length,
        prompts: held.fake.prompts.length,
        records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind),
        durables: durablesOf(yield* readSidekickRecords(sidekick)),
      };
    }
    const sent = yield* held.owner.message(said);
    return {
      ...(yield* readingOf(held.owner)),
      sent: sent.ok,
      output: sent.ok ? sent.value.output : null,
      failure: sent.ok ? (sent.value.failure ?? null) : sent.error.message,
      turn: sent.ok ? sent.value.turn : null,
      sessions: held.fake.ensured.map((one) => one.sessionKey),
      prompts: held.fake.prompts.length,
      draft: held.draft(),
      records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind),
      durables: durablesOf(yield* readSidekickRecords(sidekick)),
      turns: turnsOf(yield* readSidekickRecords(sidekick)),
    };
  }

  if (phase === "chat-read") {
    // A cold process that only looks. It assembles the whole Sidekick — the
    // provider included — and says what the history tells it, so "reopening
    // asks a provider for nothing" is observed rather than assumed.
    const held = yield* useConversing(dataRoot, execution, { replies: [] });
    return {
      ...(yield* readingOf(held.owner)),
      agent: held.owner.agent,
      // Zero of each: no session established, no turn started, nothing written.
      sessions: held.fake.ensured.length,
      prompts: held.fake.prompts.length,
      appended: appended.length,
      records: (yield* readSidekickRecords(sidekick)).map((one) => one.kind),
      durables: durablesOf(yield* readSidekickRecords(sidekick)),
      turns: turnsOf(yield* readSidekickRecords(sidekick)),
      // Every delivery claim this CLI wrote, with the turn it names. A claim
      // naming no turn asserts nothing; what establishes one either way is the
      // canonical turn above having been sent that exact text.
      feedback: (yield* readSidekickRecords(sidekick))
        .filter((one) => one.kind === "feedback")
        .map((one) => ({ turn: one.turn, text: one.text })),
    };
  }

  if (phase === "bytes") {
    // Just the bytes, so the test can compare files across the boundary
    // without reaching into another process's directory itself.
    return {
      legacy: yield* until(readFile(legacy, "utf8").catch(() => "")),
      entries: yield* until(readFile(entries, "utf8").catch(() => "")),
      // Both halves of the pair, so a case can state that reopening a finished
      // conversation changed neither file rather than only the one it watched.
      sidekick: yield* until(readFile(sidekick, "utf8").catch(() => "")),
    };
  }

  throw new Error(`there is no phase "${phase}"`);
}

await main(function* () {
  const answer = yield* phases();
  process.stdout.write(`${JSON.stringify(answer)}\n`);
});

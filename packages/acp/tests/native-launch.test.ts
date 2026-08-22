/**
 * Tier NL — native session launch through the ACPX provider
 * (specs/native-agent-session-launch-spec.md).
 *
 * Same scriptable fake runtime as the rest of the provider tests: no agent
 * process ever starts, and the native launcher is the controlled one, so what
 * is under test is the provider's own sequence — what it refuses, what it
 * asks the runtime for, when it releases the session, and what it hands the
 * launcher.
 *
 * The authority here is a stand-in for the one core delivers: it drives the
 * phases in order and keeps every record, so what a case reads is what the
 * provider produced. It deliberately validates no request — identity, lineage,
 * durability and settlement are core's half, and
 * `packages/core/tests/agent-session-launch.test.ts` owns them.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/core";
import type {
  AgentLaunchRequest,
  AgentProviderAuthority,
  LaunchRecord,
  PreparedLaunchRecord,
  Session,
} from "@executablemd/core";
import { flushOutput, installControlledLauncher, reserveTerminal } from "@executablemd/runtime";
import type { AgentSessionCoordinator, NativeLaunchRequest } from "@executablemd/runtime";
import { createAcpxProvider } from "../src/provider.ts";
import { nativeAdapterFor } from "../src/native-launch.ts";
import type { NativeAdapter } from "../src/native-launch.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import {
  createFakeRuntime,
  makeCoordinator,
  makeRecord,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "./helpers.ts";
import type { CoordinatorHarness, FakeRuntimeHarness } from "./helpers.ts";
import type { AcpSessionRecord, AcpSessionStore } from "acpx/runtime";

const CWD = "/work";
const AGENT_COMMAND = "claude-cmd";
const SESSION_KEY = deriveSessionKey(AGENT_COMMAND, CWD);

/** Everything the launch touched, in the order it touched it. */
interface Trace {
  records: LaunchRecord[];
  launches: NativeLaunchRequest[];
  /** Provider and launcher events interleaved, so ordering is provable. */
  order: string[];
  /** Who owned the session, and when. */
  ownership: CoordinatorHarness;
}

interface ProviderOptions {
  advertise?: readonly string[];
  store?: AcpSessionStore;
  adapters?: Record<string, NativeAdapter>;
  /** Blocks the native child until this resolves. */
  hold?: Operation<void>;
  onLaunch?: () => void;
  exitCode?: number;
  /**
   * Share one coordinator with another provider scope.
   *
   * Contention is a claim about one owner excluding another, and it can only be
   * made where both reach the same coordinator. Isolation is the opposite
   * claim, and making it here would prove neither.
   */
  coordinator?: AgentSessionCoordinator;
}

/**
 * What core does with each phase, minus the journal.
 *
 * Delivered the way core delivers one — directly, as the factory's second
 * argument — so the provider reaches its authority exactly as it does in a run.
 * A phase that carries a failure stops the sequence here, which is what the
 * real authority does before deriving a result.
 */
function traceAuthority(trace: Trace): AgentProviderAuthority {
  return {
    *perform(_request, phases) {
      const prepared = yield* phases.prepare();
      trace.records.push(prepared);
      trace.order.push("prepared");
      if (prepared.failure) {
        return;
      }
      const detached = yield* phases.detach(prepared);
      trace.records.push(detached);
      trace.order.push("detached");
      if (detached.failure) {
        return;
      }
      const exited = yield* phases.exit(prepared);
      trace.records.push(exited);
      trace.order.push("exited");
    },
    // deno-lint-ignore require-yield
    *refuse(_request, preparation) {
      trace.records.push(preparation);
      trace.order.push("prepared");
    },
  };
}

function* installLaunchStack(
  harness: FakeRuntimeHarness,
  trace: Trace,
  options: ProviderOptions = {},
): Operation<void> {
  yield* useFlatWorld(CWD);

  yield* installControlledLauncher({
    record: (request) => {
      trace.launches.push(request);
      trace.order.push("spawn");
    },
    ...(options.hold ? { wait: () => options.hold! } : {}),
    outcome: () => ({ exitCode: options.exitCode ?? 0 }),
  });

  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: options.store ?? makeStore(),
    agentRegistry: makeRegistry({ claude: AGENT_COMMAND, mystery: "mystery-cmd" }),
    advertiseNativeLaunch: options.advertise ?? ["claude"],
    coordinator: options.coordinator ?? trace.ownership.coordinator,
    ...(options.adapters ? { nativeAdapters: options.adapters } : {}),
  });
  yield* factory(
    { defaultAgent: "claude", permissionMode: "approve-reads" },
    traceAuthority(trace),
  );
}

function newTrace(): Trace {
  return { records: [], launches: [], order: [], ownership: makeCoordinator() };
}

/**
 * The request a document's launch would route.
 *
 * Built here rather than issued by core: what these cases exercise is the
 * provider's own sequence, and the value it needs is the description of the
 * ask. The opaque-request boundary is core's, and core's tests prove it.
 */
function launchRequest(
  instructions: string,
  options: { agent?: string; session?: string | Session } = {},
): AgentLaunchRequest {
  const request = {
    instructions,
    agent: options.agent ?? "claude",
    ...(options.session === undefined ? {} : { session: options.session }),
    cwd: CWD,
    additionalDirectories: [] as readonly string[],
    permissionMode: "approve-reads" as const,
    with: () => request,
  };
  return request;
}

/** Run a launch and report the refusal it retained, if it retained one. */
function* attempt(
  trace: Trace,
  instructions: string,
  options: { agent?: string; session?: string | Session } = {},
): Operation<PreparedLaunchRecord["failure"] | undefined> {
  yield* Agent.operations.launch(launchRequest(instructions, options));
  // The last one, so a case that launches more than once reads the attempt it
  // just made rather than the first thing that ever went wrong.
  return trace.records.findLast((record) => record.failure)?.failure;
}

/** Run a launch that is expected to complete. */
function* launch(
  instructions: string,
  options: { agent?: string; session?: string | Session } = {},
): Operation<void> {
  yield* Agent.operations.launch(launchRequest(instructions, options));
}

const INSTRUCTIONS = "You are the repository implementor.";

describe("Tier NL — native session launch", () => {
  it("NL1: an agent with no advertised native launcher is refused before a session exists", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { advertise: [] });
      const failure = yield* attempt(trace, INSTRUCTIONS);

      expect(failure?.message).toContain("not advertised as native-launch capable");
      // Refused with ACP still owning nothing at all: no session was created,
      // none was released, and no child started.
      expect(harness.ensureCalls.length).toBe(0);
      expect(harness.closeCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
      expect(failure?.class).toBe("unsupported-capability");
    });
  });

  it("NL2: an agent this package has no command shape for is refused", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { advertise: ["mystery"] });
      const failure = yield* attempt(trace, INSTRUCTIONS, { agent: "mystery" });

      expect(failure?.message).toContain("not advertised as native-launch capable");
      expect(harness.ensureCalls.length).toBe(0);
    });
  });

  it("NL3: an adapter that asserts no native identity is refused before detach", function* () {
    const harness = createFakeRuntime();
    harness.omitAgentSessionId = true;
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      const failure = yield* attempt(trace, INSTRUCTIONS);

      expect(failure?.message).toContain("asserted no provider-native session identity");
      expect(failure?.class).toBe("identity-unavailable");
      // The session exists — creating it is how the identity was asked for —
      // but ACP still owns it and nothing was spawned.
      expect(harness.ensureCalls.length).toBe(1);
      expect(harness.closeCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NL4: the prepared instructions install as the session instruction layer", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* launch(INSTRUCTIONS);

      expect(harness.ensureCalls.length).toBe(1);
      expect(harness.ensureCalls[0]).toMatchObject({
        sessionKey: SESSION_KEY,
        agent: "claude",
        mode: "persistent",
        cwd: CWD,
        sessionOptions: { systemPrompt: INSTRUCTIONS },
      });
      // No model turn: preparation and handoff start no prompt at all.
      expect(harness.turns.length).toBe(0);
    });
  });

  it("NL5: ACP ownership ends before the native child starts", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* launch(INSTRUCTIONS);

      expect(trace.order).toEqual(["prepared", "detached", "spawn", "exited"]);
      expect(harness.closeCalls.length).toBe(1);
      expect(harness.closeCalls[0]?.sessionKey).toBe(SESSION_KEY);
    });
  });

  it("NL6: only the provider-asserted native identity crosses the handoff", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* launch(INSTRUCTIONS);

      const nativeSessionId = `agent-session:${SESSION_KEY}`;
      // Read off the retained preparation, because that is where the identity
      // is authored: the public launch route answers nothing at all.
      const prepared = trace.records[0] as PreparedLaunchRecord;
      expect(prepared.nativeSessionId).toBe(nativeSessionId);
      expect(prepared.launcher).toBe("claude");
      expect(trace.launches[0]?.command).toEqual(["claude", "--resume", nativeSessionId]);
      // Three identities, all distinct, and the native CLI was handed only
      // the one the adapter asserted.
      const argv = trace.launches[0]?.command ?? [];
      expect(argv).not.toContain(`backend:${SESSION_KEY}`);
      expect(argv).not.toContain(`record:${SESSION_KEY}`);
      expect(argv).not.toContain(SESSION_KEY);
    });
  });

  it("NL7: raw instructions reach neither argv nor environment", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const sentinel = "SENTINEL-PREPARED-CONTEXT-9d2f";
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* launch(`${INSTRUCTIONS}\n${sentinel}\n`);

      const request = trace.launches[0]!;
      expect(request.command.join("\0")).not.toContain(sentinel);
      expect(JSON.stringify(request.env ?? {})).not.toContain(sentinel);
    });
  });

  it("NL8: the retained record carries cwd, permissions and the instruction channel", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* launch(INSTRUCTIONS);

      const prepared = trace.records[0];
      expect(prepared).toMatchObject({
        phase: "prepared",
        agent: "claude",
        sessionKey: SESSION_KEY,
        provider: "acpx",
        sessionState: "created",
        instructionChannel: "acp.session.systemPrompt",
        instructions: INSTRUCTIONS,
        cwd: CWD,
        additionalDirectories: [],
        permissionMode: "approve-reads",
        launcher: "claude",
      });
    });
  });

  it("NL9: relaunching the same session with different instructions is refused", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const existing: AcpSessionRecord = {
      ...makeRecord(AGENT_COMMAND, CWD),
      acpxRecordId: SESSION_KEY,
      acpx: { session_options: { system_prompt: "an older instruction layer" } },
      // A session that has held a conversation. Replacing its layer would
      // mean discarding what the agent and the person said to each other.
      messages: [{ User: { id: "u1", content: [{ Text: "hello" }] } }],
    };
    const store = makeStore({ [SESSION_KEY]: existing });
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { store });
      const failure = yield* attempt(trace, INSTRUCTIONS);

      expect(failure?.message).toContain("already carries a different XMD instruction layer");
      expect(failure?.class).toBe("instructions-refused");
      // The provider does not quietly launch with the stale layer in force,
      // and does not discard the conversation to replace it either.
      expect(harness.ensureCalls.length).toBe(0);
      expect(harness.closeCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NL10: relaunching the same instruction layer resumes the same session", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const existing: AcpSessionRecord = {
      ...makeRecord(AGENT_COMMAND, CWD),
      acpxRecordId: SESSION_KEY,
      acpx: { session_options: { system_prompt: INSTRUCTIONS } },
    };
    const store = makeStore({ [SESSION_KEY]: existing });
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { store });
      yield* launch(INSTRUCTIONS);

      const prepared = trace.records[0];
      expect(prepared).toMatchObject({ phase: "prepared", sessionState: "resumed" });
      expect(trace.launches.length).toBe(1);
    });
  });

  it("NL11: a later prompt reattaches instead of using the pre-handoff handle", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* launch(INSTRUCTIONS);
      // The handle the launch released is the last one this provider held.
      expect(harness.closeCalls.at(-1)?.sessionKey).toBe(SESSION_KEY);
      const ensuresAfterLaunch = harness.ensureCalls.length;

      // The same logical session the launch prepared. Reaching it after the
      // handoff re-ensures rather than reusing the handle that predates it.
      yield* scoped(function* () {
        const stream = yield* Agent.operations.prompt("what changed?", {});
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });

      expect(harness.ensureCalls.length).toBe(ensuresAfterLaunch + 1);
      expect(harness.ensureCalls.at(-1)?.sessionKey).toBe(SESSION_KEY);
      expect(harness.turns.length).toBe(1);
    });
  });

  it("NL12: a prompt for a session a native launch owns is refused, not queued", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const hold = withResolvers<void>();
    const started = withResolvers<void>();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, {
        hold: (function* () {
          started.resolve();
          yield* hold.operation;
        })(),
      });

      const launching = yield* spawn(() => launch(INSTRUCTIONS));
      yield* started.operation;

      // Acquisition never waits. A native UI may hold the session for hours,
      // and a prompt that queued would hold the reader's terminal while
      // offering no way to reach the owner it is waiting for.
      const refused = yield* spawn(function* (): Operation<Error | undefined> {
        try {
          yield* scoped(function* () {
            const stream = yield* Agent.operations.prompt("meanwhile", {});
            const subscription = yield* stream;
            let next = yield* subscription.next();
            while (!next.done) {
              next = yield* subscription.next();
            }
          });
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      });

      expect((yield* refused)?.name).toBe("AgentSessionBusy");
      // The native child owns the session, so nothing ran a turn against it.
      expect(harness.turns.length).toBe(0);
      expect(trace.ownership.acquisitions.at(-1)).toMatchObject({
        kind: "prompt",
        outcome: "busy",
      });

      hold.resolve();
      yield* launching;

      expect(trace.order).toEqual(["prepared", "detached", "spawn", "exited"]);
    });
  });

  it("NL13: a nonzero native exit is the launch's outcome, and the session facts stand", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { exitCode: 7 });
      yield* launch(INSTRUCTIONS);

      // The provider reports what happened; deciding that a nonzero status
      // fails the document belongs to the authority that derives the result.
      expect(trace.records.at(-1)).toMatchObject({ phase: "exited", exitCode: 7 });
      const prepared = trace.records[0];
      expect(prepared).toMatchObject({ nativeSessionId: `agent-session:${SESSION_KEY}` });
    });
  });

  it("NL15: a session established before the launch is refused, never converted", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      // What an enclosing `<Session name>` does before the `<Session.Launch>`
      // inside it: establishes the session, with no instruction layer at all.
      const session = yield* Agent.operations.session();
      expect(harness.ensureCalls.length).toBe(1);
      const closesBefore = harness.closeCalls.length;

      const failure = yield* attempt(trace, INSTRUCTIONS, { session });

      // ACPX fixes a layer when the ACP session is created, so putting a
      // different one in force would mean discarding the session — and an
      // empty local transcript is not evidence that would be safe.
      expect(failure?.class).toBe("instructions-refused");
      expect(failure?.message).toContain("already carries a different XMD instruction layer");
      expect(harness.closeCalls.length).toBe(closesBefore);
      expect(harness.ensureCalls.length).toBe(1);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NL16: a session a native UI already owned is never discarded to change its layer", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      // The launch constructs the session, so this one carries its layer.
      yield* launch(INSTRUCTIONS);
      expect(trace.launches.length).toBe(1);

      const discardsBefore = harness.closeCalls.length;
      // The native UI has been used for an hour. ACPX never sees those turns,
      // so its cached `messages` is still empty — which is exactly the
      // evidence that must not authorize a discard.
      const cached = yield* until(harness.createdOptions[0]!.sessionStore.load(SESSION_KEY));
      expect(cached?.messages ?? []).toEqual([]);

      const failure = yield* attempt(trace, "A completely different role.");

      expect(failure?.class).toBe("instructions-refused");
      expect(failure?.message).toContain("already carries a different XMD instruction layer");
      // Nothing was discarded, nothing detached, nothing spawned.
      expect(harness.closeCalls.length).toBe(discardsBefore);
      expect(trace.launches.length).toBe(1);
    });
  });

  it("NL17: a session that has been prompted is never discarded either", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      const session = yield* Agent.operations.session();
      yield* scoped(function* () {
        const stream = yield* Agent.operations.prompt("hello", { session });
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });

      const failure = yield* attempt(trace, INSTRUCTIONS);

      expect(failure?.class).toBe("instructions-refused");
      expect(failure?.message).toContain("already carries a different XMD instruction layer");
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NL18: the record says what was done about the instruction layer", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      // A fresh session: the layer is installed with it.
      yield* launch(INSTRUCTIONS);
      expect(trace.records[0]).toMatchObject({ instructionReconciliation: "installed" });
    });

    const second = createFakeRuntime();
    const resumedTrace = newTrace();
    const existing: AcpSessionRecord = {
      ...makeRecord(AGENT_COMMAND, CWD),
      acpxRecordId: SESSION_KEY,
      acpx: { session_options: { system_prompt: INSTRUCTIONS } },
    };
    yield* scoped(function* () {
      yield* installLaunchStack(second, resumedTrace, {
        store: makeStore({ [SESSION_KEY]: existing }),
      });
      yield* launch(INSTRUCTIONS);
      expect(resumedTrace.records[0]).toMatchObject({ instructionReconciliation: "resumed" });
    });
  });

  it("NL14: the built-in adapters build the documented resume commands", function* () {
    const claude = nativeAdapterFor("claude");
    const codex = nativeAdapterFor("codex");

    expect(claude?.launcher).toBe("claude");
    expect(claude?.resume("abc-123")).toEqual(["claude", "--resume", "abc-123"]);
    expect(codex?.launcher).toBe("codex");
    expect(codex?.resume("abc-123")).toEqual(["codex", "resume", "abc-123"]);
    expect(nativeAdapterFor("gemini")).toBe(undefined);
  });
});

/**
 * Tier NO — session ownership across every operation that can act on one
 * (specs/native-agent-session-launch-spec.md §Ownership and concurrency).
 *
 * The coordinator here is the recording in-memory one: same answers as the
 * Deno adapter, no filesystem. What these cases are about is which provider
 * operations enter it, under which owner kind, and what they do when the
 * answer is no — `packages/runtime/tests/agent-session-coordinator.test.ts`
 * owns the durability and cross-process halves.
 */
describe("Tier NO — session ownership", () => {
  it("NO1: agent resolution and placement own nothing; session, prompt and launch do", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);

      // Resolving an agent reads a registry. There is no session yet to own.
      yield* Agent.operations.agent();
      // Constructing a prompt stream chooses nothing and starts nothing.
      const cold = yield* Agent.operations.prompt("later", {});
      expect(trace.ownership.acquisitions).toEqual([]);

      yield* Agent.operations.session();
      yield* scoped(function* () {
        const subscription = yield* cold;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });
      yield* launch(INSTRUCTIONS);

      expect(trace.ownership.acquisitions.map((entry) => entry.kind)).toEqual([
        "session",
        "prompt",
        "native-launch",
      ]);
      // One logical session, named the same way by all three.
      for (const entry of trace.ownership.acquisitions) {
        expect(entry.key).toEqual({
          provider: "acpx",
          agent: AGENT_COMMAND,
          sessionKey: SESSION_KEY,
        });
        expect(entry.outcome).toBe("granted");
      }
    });
  });

  it("NO2: an agent nobody can launch keeps ordinary ACP behavior", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      // Nothing advertised, so no session this provider returns can be handed
      // to a native UI — and ownership is not the question.
      yield* installLaunchStack(harness, trace, { advertise: [] });
      yield* Agent.operations.session();

      expect(trace.ownership.acquisitions).toEqual([]);
      expect(harness.ensureCalls.length).toBe(1);
    });
  });

  it("NO3: a sibling provider scope holding the session excludes a launch", function* () {
    const store = makeStore();
    const shared = makeCoordinator();
    const held = createFakeRuntime();
    const contender = createFakeRuntime();
    const holderTrace = newTrace();
    const contenderTrace = newTrace();
    const hold = withResolvers<void>();
    const started = withResolvers<void>();

    yield* scoped(function* () {
      // Two provider scopes, one store and one coordinator: the same logical
      // session, reached twice. Provider-local state is not what excludes them.
      const launching = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* installLaunchStack(held, holderTrace, {
            store,
            coordinator: shared.coordinator,
            hold: (function* () {
              started.resolve();
              yield* hold.operation;
            })(),
          });
          yield* launch(INSTRUCTIONS);
        });
      });
      yield* started.operation;

      const refusal = yield* scoped(function* () {
        yield* installLaunchStack(contender, contenderTrace, {
          store,
          coordinator: shared.coordinator,
        });
        return yield* attempt(contenderTrace, INSTRUCTIONS);
      });

      // Answered immediately, and retained as a refusal rather than raised:
      // the reader is told what to do about it.
      expect(refusal?.class).toBe("session-busy");
      // The contender did no ACP work and started no child.
      expect(contender.ensureCalls.length).toBe(0);
      expect(contender.closeCalls.length).toBe(0);
      expect(contenderTrace.launches.length).toBe(0);
      expect(contenderTrace.order).toEqual(["prepared"]);

      hold.resolve();
      yield* launching;
    });
  });

  it("NO4: a released session is free again, and its record says idle", function* () {
    const store = makeStore();
    const shared = makeCoordinator();
    const first = createFakeRuntime();
    const second = createFakeRuntime();
    const firstTrace = newTrace();
    const secondTrace = newTrace();

    yield* scoped(function* () {
      yield* scoped(function* () {
        yield* installLaunchStack(first, firstTrace, {
          store,
          coordinator: shared.coordinator,
        });
        yield* launch(INSTRUCTIONS);
      });

      yield* scoped(function* () {
        yield* installLaunchStack(second, secondTrace, {
          store,
          coordinator: shared.coordinator,
        });
        // The same layer, so the session resumes rather than being refused.
        yield* launch(INSTRUCTIONS);
      });

      expect(shared.acquisitions.map((entry) => entry.outcome)).toEqual(["granted", "granted"]);
      expect(secondTrace.launches.length).toBe(1);
    });
  });

  it("NO5: a session whose last owner never proved it stopped is not reused", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      // What a crashed owner leaves: the lock is gone, the record is not.
      trace.ownership.tombstone({
        provider: "acpx",
        agent: AGENT_COMMAND,
        sessionKey: SESSION_KEY,
      });

      const refusal = yield* attempt(trace, INSTRUCTIONS);

      expect(refusal?.class).toBe("session-recovery-required");
      expect(harness.ensureCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NO6: a host with no coordinator refuses before contacting the agent", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      yield* installControlledLauncher({
        record: (request) => trace.launches.push(request),
        outcome: () => ({ exitCode: 0 }),
      });
      // No coordinator at all: the shape Node and Bun run in.
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ claude: AGENT_COMMAND }),
        advertiseNativeLaunch: ["claude"],
      });
      yield* factory(
        { defaultAgent: "claude", permissionMode: "approve-reads" },
        traceAuthority(trace),
      );

      const refusal = yield* attempt(trace, INSTRUCTIONS);

      expect(refusal?.class).toBe("unsupported-capability");
      expect(harness.ensureCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NO7: the terminal is reserved and flushed before ownership is asked for", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const order: string[] = [];
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      yield* installControlledLauncher({
        onReserve: () => order.push("reserve"),
        onFlush: () => order.push("flush"),
        record: () => order.push("spawn"),
        outcome: () => ({ exitCode: 0 }),
      });
      const ownership = makeCoordinator();
      const watched: AgentSessionCoordinator = {
        coordinate(key, owner, body) {
          order.push("coordinate");
          return ownership.coordinator.coordinate(key, owner, body);
        },
      };
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ claude: AGENT_COMMAND }),
        advertiseNativeLaunch: ["claude"],
        coordinator: watched,
      });
      yield* factory(
        { defaultAgent: "claude", permissionMode: "approve-reads" },
        traceAuthority(trace),
      );

      // The terminal lease belongs to the launch's caller, so this stack
      // reserves it the way `Agent.launch()` does before routing.
      yield* reserveTerminal();
      yield* flushOutput();
      yield* launch(INSTRUCTIONS);

      expect(order).toEqual(["reserve", "flush", "coordinate", "spawn"]);
    });
  });

  it("NO8: a cancelled prompt releases only after its turn and handle are done", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);

      const prompting = yield* spawn(function* () {
        yield* scoped(function* () {
          const stream = yield* Agent.operations.prompt("hold on", {});
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
        });
      });
      // The turn exists, so ownership has been taken.
      while (harness.turns.length === 0) {
        yield* sleep(1);
      }
      expect(trace.ownership.acquisitions.at(-1)).toMatchObject({
        kind: "prompt",
        outcome: "granted",
      });
      const closesBefore = harness.closeCalls.length;

      yield* prompting.halt();

      // The ACP handle was given up and the turn cancelled before ownership
      // ended, so the next owner finds the session free rather than in use.
      expect(harness.turns[0]?.cancelled).toBe(true);
      expect(harness.closeCalls.length).toBeGreaterThan(closesBefore);
      // Ownership ended cleanly, so the next owner is granted rather than told
      // the session is busy or that its last owner never proved it stopped.
      yield* Agent.operations.session();
      expect(trace.ownership.acquisitions.at(-1)).toMatchObject({
        kind: "session",
        outcome: "granted",
      });
    });
  });

  it("NO9: a launch that could not release ACP leaves the session owned", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    // The provider's detach fails, so nothing ever proves the session stopped
    // being acted on — and the record must stay active.
    harness.closeFailure = new Error("the agent connection would not close");
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      const refusal = yield* attempt(trace, INSTRUCTIONS);

      expect(refusal?.class).toBe("detach-failed");
      expect(trace.launches.length).toBe(0);

      // The next owner is told to recover it rather than being handed a
      // session an unfinished handoff may still be in.
      const next = yield* attempt(trace, INSTRUCTIONS);
      expect(next?.class).toBe("session-recovery-required");
      expect(trace.ownership.acquisitions.at(-1)?.outcome).toBe("recovery-required");
      // Let this provider's own teardown release what it is still holding.
      harness.closeFailure = undefined;
    });
  });

  it("NO11: a release whose ACP close failed keeps the session owned", function* () {
    // The ordinary release path, which `session()` and a prompt's cleanup
    // share. A close that failed released nothing, so nothing may say this
    // owner stopped — and the next one is told to recover the session rather
    // than being handed one an unfinished release may still be in.
    for (const site of ["session", "prompt"] as const) {
      const harness = createFakeRuntime();
      const trace = newTrace();
      // Observed inside, asserted outside: this scope's teardown reports the
      // close it could not complete, and a failure raised in the body would be
      // replaced by it — so an assertion in there proves nothing.
      const seen: Record<string, unknown> = {};
      let reported: Error | undefined;
      try {
        yield* scoped(function* () {
          yield* installLaunchStack(harness, trace);
          harness.closeFailure = new Error("the agent connection would not close");

          if (site === "session") {
            yield* Agent.operations.session();
          } else {
            yield* scoped(function* () {
              const stream = yield* Agent.operations.prompt("hello", {});
              const subscription = yield* stream;
              let next = yield* subscription.next();
              while (!next.done) {
                next = yield* subscription.next();
              }
            });
          }

          const ensured = harness.ensureCalls.length;
          const refusal = yield* attempt(trace, INSTRUCTIONS);
          seen.establishedOne = ensured === 1;
          seen.refusal = refusal?.class;
          seen.ownership = trace.ownership.acquisitions.at(-1)?.outcome;
          seen.noFurtherAcp = harness.ensureCalls.length === ensured;
          seen.launches = trace.launches.length;

          // Let teardown's own close succeed, so what it reports below is the
          // one release that actually failed.
          harness.closeFailure = undefined;
        });
      } catch (error) {
        reported = error instanceof Error ? error : new Error(String(error));
      }

      expect([site, seen]).toEqual([
        site,
        {
          establishedOne: true,
          // Quiescence was never acknowledged, so the record is still active,
          // and the next owner is refused before any ACP work.
          refusal: "session-recovery-required",
          ownership: "recovery-required",
          noFurtherAcp: true,
          launches: 0,
        },
      ]);
      // Preserved: the provider scope still reports the close it could not
      // complete, rather than swallowing it to keep the session looking clean.
      expect([site, reported?.message]).toEqual([site, "the agent connection would not close"]);
    }
  });

  it("NO10: no launch path ever discards persistent session state", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* Agent.operations.session();
      yield* scoped(function* () {
        const stream = yield* Agent.operations.prompt("hello", {});
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });
      // Equal layer, so this one goes all the way through.
      yield* attempt(trace, INSTRUCTIONS);

      expect(harness.closeInputs.length).toBeGreaterThan(0);
      for (const input of harness.closeInputs) {
        expect(input.discardPersistentState).toBeUndefined();
      }
    });
  });
});

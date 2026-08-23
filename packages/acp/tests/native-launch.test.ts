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
import { ensure, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/core";
import type {
  AgentLaunchRequest,
  AgentProviderAuthority,
  ExitedLaunchRecord,
  LaunchRecord,
  PreparedLaunchRecord,
  Session,
} from "@executablemd/core";
import { flushOutput, installControlledLauncher, reserveTerminal } from "@executablemd/runtime";
import type { AgentSessionCoordinator, NativeLaunchRequest } from "@executablemd/runtime";
import { createAcpxProvider } from "../src/provider.ts";
import {
  ADVERTISED_NATIVE_LAUNCH,
  allocatesIdentity,
  knownNativeAdapters,
  nativeAdapterFor,
} from "../src/native-launch.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import type { NativeAdapter } from "../src/native-launch.ts";
import { AgentSessionRouteError, createMemorySessionRouteStore } from "../src/session-route.ts";
import type { AgentSessionRouteStore, AgentSessionRouteV1 } from "../src/session-route.ts";
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
  /**
   * What the next launch in this trace replays, if anything.
   *
   * Read at each `perform` rather than fixed when the provider is installed, so
   * one provider scope can run a prepared-only replay and then a detached one —
   * which is the only way to show that neither answers the other.
   */
  replay?: Replay;
}

interface ProviderOptions {
  advertise?: readonly string[];
  store?: AcpSessionStore;
  adapters?: Record<string, NativeAdapter>;
  /**
   * Give this scope a construction-route store.
   *
   * Off by default: Tier NL is the provider-returned contract, and a host that
   * keeps no routes has to serve it exactly as it did before #519.
   */
  routeStore?: AgentSessionRouteStore;
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
 * What the journal gives an incomplete replay back.
 *
 * The suffix is the whole question. A launch interrupted after preparing but
 * before detaching retained only `prepared`, so its replay runs detach live and
 * native creation may never have begun. One interrupted after detaching
 * retained both, so the native process was already free to start and the replay
 * may do nothing but resume.
 */
interface Replay {
  prepared: PreparedLaunchRecord;
  suffix: "prepared" | "prepared+detached";
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
      // A replay hands back what the journal retained rather than calling the
      // provider's live preparation, exactly as the real authority does when
      // the phase is already recorded.
      const replay = trace.replay;
      if (replay) {
        trace.records.push(replay.prepared);
        trace.order.push("prepared");
        // Only a journal that reached `detached` replays it. The other suffix
        // runs the provider's detach live, which is how a replay learns its
        // predecessor never got as far as handing the session over.
        const detached =
          replay.suffix === "prepared+detached"
            ? { phase: "detached" as const }
            : yield* phases.detach(replay.prepared);
        trace.records.push(detached);
        trace.order.push("detached");
        if (detached.failure) {
          return;
        }
        const exited = yield* phases.exit(replay.prepared);
        trace.records.push(exited);
        trace.order.push("exited");
        return;
      }
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
    ...(options.routeStore ? { routeStore: options.routeStore } : {}),
    nativeAdapters: options.adapters ?? { claude: PROVIDER_RETURNED_CLAUDE },
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
 * A Claude-shaped adapter that returns its own identity.
 *
 * What the merged #518 provider always assumed: ACP creates the session and the
 * adapter reports what it is called. Declared here rather than in the package,
 * because the real Claude adapter names its own sessions now — and Tier NL is
 * the proof that the other kind still works exactly as it did, on a host that
 * keeps no construction routes at all.
 */
const PROVIDER_RETURNED_CLAUDE: NativeAdapter = {
  launcher: "claude",
  identity: "provider-returned",
  resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
};

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

  it("NL19: claude is the only advertised adapter, and it names its own sessions", function* () {
    // Advertisement is a claim about what has been proven against an installed
    // CLI, and the two documents beside this package's source are what proved
    // it: `ClaudeNativeLaunch.test.md` and `ClaudeZeroTurnExit.test.md`, run
    // through the built binary against Claude Code 2.1.241 on macOS arm64.
    expect([...ADVERTISED_NATIVE_LAUNCH]).toEqual(["claude"]);

    const claude = nativeAdapterFor("claude");
    expect(claude !== undefined && allocatesIdentity(claude)).toBe(true);
    expect(claude?.identity).toBe("client-allocated");

    // Knowing a command shape is still not the same as being launch-capable.
    // Codex keeps its adapter and its contract tests, and nothing has run it
    // against an installed Codex — so it stays off the list.
    expect(knownNativeAdapters()).toEqual(["claude", "codex"]);
    expect(ADVERTISED_NATIVE_LAUNCH).not.toContain("codex");
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
        nativeAdapters: { claude: PROVIDER_RETURNED_CLAUDE },
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
        nativeAdapters: { claude: PROVIDER_RETURNED_CLAUDE },
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

/**
 * Tier CN — a session XMD names itself
 * (specs/native-agent-session-launch-spec.md §Construction route).
 *
 * The other way round from Tier NL. Here the adapter allocates the identity
 * before any process exists, the native process is told which conversation to
 * make, and the durable construction route is what stops the same session from
 * later being constructed a second way. Nothing is created through ACP at all.
 */
describe("Tier CN — client-allocated construction", () => {
  const ALLOCATED = "11111111-2222-3333-4444-555555555555";

  /** The controlled Claude-shaped adapter that names its own sessions. */
  function clientNative(allocate: () => string = () => ALLOCATED): NativeAdapter {
    return {
      launcher: "claude",
      identity: "client-allocated",
      allocate,
      create: (nativeSessionId, instructionFile) => [
        "claude",
        "--session-id",
        nativeSessionId,
        "--system-prompt-file",
        instructionFile,
      ],
      resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
    };
  }

  function* installClientNative(
    harness: FakeRuntimeHarness,
    trace: Trace,
    options: ProviderOptions & { allocate?: () => string } = {},
  ): Operation<void> {
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: clientNative(options.allocate) },
      routeStore: options.routeStore ?? createMemorySessionRouteStore(),
      ...options,
    });
  }

  function* routeOf(store: AgentSessionRouteStore): Operation<AgentSessionRouteV1 | undefined> {
    return yield* store.read({ provider: "acpx", agent: AGENT_COMMAND, sessionKey: SESSION_KEY });
  }

  it("CN1: the adapter names the session, and only that name crosses", function* () {
    // What shape a provider-native identity takes is knowledge about that
    // provider, so the adapter is what produces one. Nothing else may supply
    // it: not an authored value, not an ACP session id, not an ACPX record id,
    // not a string that merely looks like a UUID.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const owned: string[] = [];
    yield* installClientNative(harness, trace, {
      routeStore: routes,
      allocate: () => {
        owned.push(trace.ownership.events.at(-1) ?? "none");
        return ALLOCATED;
      },
    });

    yield* launch(INSTRUCTIONS);
    const prepared = trace.records[0] as PreparedLaunchRecord;

    // Allocated while the coordinator held this session, so the route it is
    // published under is the one ownership is protecting.
    expect(owned).toEqual(["owned"]);
    expect(prepared.identityProvenance).toBe("client-allocated");
    expect(prepared.nativeSessionId).toBe(ALLOCATED);
    const route = yield* routeOf(routes);
    expect(route).toEqual({
      schema: "session-route.v1",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
      nativeSessionId: ALLOCATED,
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      launcher: "claude",
    });
    expect(trace.launches[0]!.command).toContain(ALLOCATED);
    // ACP created nothing: this session is materialized by the native process.
    expect(harness.ensureCalls).toEqual([]);
  });

  it("CN2: a fresh construction hands over a private instruction file", function* () {
    // The layer crosses as a path, never as text, so the prepared instructions
    // are absent from the process table and from the environment.
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* installClientNative(harness, trace);

    yield* launch(INSTRUCTIONS);

    const command = trace.launches[0]!.command;
    expect(command[0]).toBe("claude");
    expect(command).toContain("--session-id");
    expect(command).toContain("--system-prompt-file");
    expect(command).not.toContain("--resume");
    expect(command.join(" ")).not.toContain(INSTRUCTIONS);
    expect(JSON.stringify(trace.launches[0]!.env ?? {})).not.toContain(INSTRUCTIONS);
    expect(harness.turns).toEqual([]);
  });

  it("CN3: a later independent launch resumes and allocates nothing", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    let allocations = 0;
    yield* installClientNative(harness, trace, {
      routeStore: routes,
      allocate: () => {
        allocations += 1;
        return ALLOCATED;
      },
    });

    yield* launch(INSTRUCTIONS);
    yield* launch(INSTRUCTIONS);

    // The first durable publication is authoritative, so the second launch
    // adopts its identity rather than insisting its own candidate win.
    expect(trace.launches.length).toBe(2);
    expect(trace.launches[1]!.command).toEqual(["claude", "--resume", ALLOCATED]);
    // Nothing was allocated the second time: a session that already has an
    // identity is resumed under it, and a second candidate for a conversation
    // that already exists is a value with nowhere to go.
    expect(allocations).toBe(1);
    const second = trace.records.findLast(
      (record) => record.phase === "prepared",
    ) as PreparedLaunchRecord;
    expect(second.nativeSessionId).toBe(ALLOCATED);
    expect(second.sessionState).toBe("resumed");
  });

  it("CN4: a different instruction layer is refused, and nothing is replaced", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installClientNative(harness, trace, { routeStore: routes });
    yield* launch(INSTRUCTIONS);
    const published = yield* routeOf(routes);

    const refusal = yield* attempt(trace, "You are somebody else entirely.");

    expect(refusal?.class).toBe("instructions-refused");
    expect(trace.launches.length).toBe(1);
    expect(yield* routeOf(routes)).toEqual(published);
  });

  it("CN5: existing ACP history is upgraded to acp-first, then refused", function* () {
    // A session this provider established before construction routes existed.
    // What it is has never been written down, so a launch that only refused
    // would leave the same open question for the next run to answer differently.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const store = makeStore({
      [SESSION_KEY]: { ...makeRecord(AGENT_COMMAND, CWD), acpxRecordId: SESSION_KEY, messages: [] },
    });
    yield* installClientNative(harness, trace, { routeStore: routes, store });
    expect(yield* routeOf(routes)).toBe(undefined);

    const refusal = yield* attempt(trace, INSTRUCTIONS);

    expect(refusal?.class).toBe("identity-unavailable");
    expect(yield* routeOf(routes)).toEqual({
      schema: "session-route.v1",
      route: "acp-first",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
    });
    // Refused before an identity existed, before a private file, and before
    // any detach or spawn.
    expect(trace.launches).toEqual([]);
    expect(harness.ensureCalls).toEqual([]);
  });

  it("CN6: an eager Session publishes acp-first, and the launch inside it refuses", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installClientNative(harness, trace, { routeStore: routes });

    yield* Agent.operations.session();
    expect((yield* routeOf(routes))?.route).toBe("acp-first");

    const refusal = yield* attempt(trace, INSTRUCTIONS);

    expect(refusal?.class).toBe("identity-unavailable");
    expect(trace.launches).toEqual([]);
  });

  it("CN10: the route is published before any provider work exists", function* () {
    // Creating provider history first and writing down how it was constructed
    // afterwards leaves a window in which a crash makes the session look
    // unconstructed — and a launch meeting that window would give a
    // conversation that already exists a second identity.
    const order: string[] = [];
    const inner = createMemorySessionRouteStore();
    const routes: AgentSessionRouteStore = {
      *read(key) {
        return yield* inner.read(key);
      },
      *publish(candidate) {
        order.push("publish");
        return yield* inner.publish(candidate);
      },
    };
    const harness = createFakeRuntime();
    const watched: FakeRuntimeHarness = {
      ...harness,
      create(options) {
        order.push("runtime");
        return harness.create(options);
      },
    };
    const trace = newTrace();
    yield* installClientNative(watched, trace, { routeStore: routes });

    yield* Agent.operations.session();

    expect(order).toEqual(["publish", "runtime"]);
    // And resolution asked no agent whether it was available: probing spawns a
    // child, which is provider work on a session nothing has settled yet.
    expect(harness.doctorCalls).toBe(0);
    expect(harness.ensureCalls.length).toBe(1);
  });

  it("CN7: a failed ensure leaves the acp-first route standing", function* () {
    // The route is published before the provider reaches for an agent, so a
    // session that could not be established has still said how it was going to
    // be constructed. Deleting it would let the next run construct it the other
    // way against provider state that may already exist.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    harness.ensureFailure = new Error("the agent could not be reached");
    yield* installClientNative(harness, trace, { routeStore: routes });

    let raised: Error | undefined;
    try {
      yield* Agent.operations.session();
    } catch (error) {
      raised = error as Error;
    }

    expect(raised?.message).toContain("could not be reached");
    expect((yield* routeOf(routes))?.route).toBe("acp-first");
  });

  it("CN8: a Session on a client-native route raises rather than retaining a launch", function* () {
    // There is no launch here, so there is no launch record to fail. The
    // provider says so in its own error, before a runtime, an ensure or a turn.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installClientNative(harness, trace, { routeStore: routes });
    yield* launch(INSTRUCTIONS);
    const ensuresBefore = harness.ensureCalls.length;

    const doctorsBefore = harness.doctorCalls;
    const runtimesBefore = harness.createdOptions.length;

    let raised: Error | undefined;
    try {
      yield* Agent.operations.session();
    } catch (error) {
      raised = error as Error;
    }

    expect(raised?.name).toBe("AgentSessionRouteError");
    expect(raised?.message).toContain("client-allocated identity");
    // Zero provider work: no probe child, no runtime, no ensure, no turn.
    expect(harness.doctorCalls).toBe(doctorsBefore);
    expect(harness.createdOptions.length).toBe(runtimesBefore);
    expect(harness.ensureCalls.length).toBe(ensuresBefore);
    expect(harness.turns).toEqual([]);
    expect(trace.records.filter((record) => record.failure)).toEqual([]);
  });

  it("CN11: a route this build cannot read is a launch outcome, not an escape", function* () {
    // The strict store raises; the launch surface turns that into the failure
    // the reader asked about. A session cannot be confirmed, so the launch
    // says so — rather than the error travelling past the launch and leaving
    // it with no retained phase at all.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes: AgentSessionRouteStore = {
      // deno-lint-ignore require-yield
      *read() {
        throw new AgentSessionRouteError(
          "the construction route record for this session is state this build cannot account " +
            "for, so it is not acted on",
        );
      },
      // deno-lint-ignore require-yield
      *publish(candidate) {
        return candidate;
      },
    };
    yield* installClientNative(harness, trace, { routeStore: routes });

    const refusal = yield* attempt(trace, INSTRUCTIONS);

    expect(refusal?.class).toBe("identity-unavailable");
    expect(refusal?.message).toContain("cannot account for");
    // Refused at preparation, before allocation, a private file, detach or spawn.
    expect(trace.order).toEqual(["prepared"]);
    expect(trace.launches).toEqual([]);
    expect(harness.ensureCalls).toEqual([]);

    // The same surface, reached by a failure that is not this package's own.
    // A filesystem error says where it was, and where a durable route lives is
    // host layout — so it is replaced rather than quoted.
    const marker = "xmd-route-root-91fd";
    const rawTrace = newTrace();
    yield* installClientNative(createFakeRuntime(), rawTrace, {
      routeStore: {
        // deno-lint-ignore require-yield
        *read() {
          throw new Error(`EACCES: /var/private/${marker}/routes/abc.json`);
        },
        // deno-lint-ignore require-yield
        *publish(candidate) {
          return candidate;
        },
      },
    });

    const raw = yield* attempt(rawTrace, INSTRUCTIONS);

    expect(raw?.class).toBe("identity-unavailable");
    expect(raw?.message).not.toContain(marker);
    expect(JSON.stringify(rawTrace.records).includes(marker)).toBe(false);
  });

  it("CN9: a host with no route store refuses before any provider effect", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* installLaunchStack(harness, trace, { adapters: { claude: clientNative() } });

    const refusal = yield* attempt(trace, INSTRUCTIONS);

    expect(refusal?.class).toBe("unsupported-capability");
    expect(refusal?.message).toContain("construction routes");
    // Refused before the provider was contacted at all.
    expect(harness.doctorCalls).toBe(0);
    expect(harness.createdOptions).toEqual([]);
    expect(harness.ensureCalls).toEqual([]);
    expect(trace.launches).toEqual([]);
  });
});

/**
 * Tier CR — resuming a client-allocated launch that did not finish
 * (specs/native-agent-session-launch-spec.md §Replay).
 *
 * The retained phase is the whole answer. Core retains `detached` before it
 * invokes the exit phase, so a journal holding only `prepared` proves the
 * handoff never began and creation may still be owed. A journal that reached
 * `detached` may already have had a process start under this identity, so its
 * replay resumes and never falls back to creating.
 */
describe("Tier CR — client-allocated incomplete replay", () => {
  const ALLOCATED = "22222222-3333-4444-5555-666666666666";

  const ADAPTER: NativeAdapter = {
    launcher: "claude",
    identity: "client-allocated",
    allocate: () => ALLOCATED,
    create: (nativeSessionId, instructionFile) => [
      "claude",
      "--session-id",
      nativeSessionId,
      "--system-prompt-file",
      instructionFile,
    ],
    resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
  };

  /** A retained prepared record, as an interrupted launch would have left one. */
  function retained(overrides: Partial<PreparedLaunchRecord> = {}): PreparedLaunchRecord {
    return {
      phase: "prepared",
      agent: "claude",
      sessionKey: SESSION_KEY,
      provider: "acpx",
      nativeSessionId: ALLOCATED,
      sessionState: "created",
      instructionChannel: "claude.systemPromptFile",
      instructionReconciliation: "installed",
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      instructions: INSTRUCTIONS,
      cwd: CWD,
      additionalDirectories: [],
      permissionMode: "approve-reads",
      launcher: "claude",
      ...overrides,
    };
  }

  const KEY = { provider: "acpx", agent: AGENT_COMMAND, sessionKey: SESSION_KEY };

  /** An ACP-first route for the same session, which no launch may adopt. */
  function acpFirst(): AgentSessionRouteV1 {
    return {
      schema: "session-route.v1",
      route: "acp-first",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
    };
  }

  /** The route that agrees with it. */
  function agreeing(record: PreparedLaunchRecord): AgentSessionRouteV1 {
    return {
      schema: "session-route.v1",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: record.sessionKey,
      nativeSessionId: record.nativeSessionId,
      identityProvenance: "client-allocated",
      instructionsDigest: record.instructionsDigest,
      launcher: record.launcher,
    };
  }

  function* installReplay(
    harness: FakeRuntimeHarness,
    trace: Trace,
    routes: AgentSessionRouteStore,
    suffix: Replay["suffix"],
    overrides: Partial<PreparedLaunchRecord> = {},
  ): Operation<void> {
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: ADAPTER },
      routeStore: routes,
    });
    trace.replay = { prepared: retained(overrides), suffix };
  }

  it("CR1: a detached replay resumes, and never falls back to creating", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installReplay(harness, trace, routes, "prepared+detached");
    yield* routes.publish(agreeing(retained()));

    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

    expect(trace.launches[0]!.command).toEqual(["claude", "--resume", ALLOCATED]);
    expect(harness.ensureCalls).toEqual([]);
  });

  it("CR2: a prepared-only replay creates under the retained identity", function* () {
    // The predecessor never detached, so nothing handed this session to a
    // native process and creation may still be owed. The identity is not
    // reallocated — a second one would be a second conversation — so the create
    // argv carries the retained one, with a file this run wrote.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installReplay(harness, trace, routes, "prepared");
    yield* routes.publish(agreeing(retained()));

    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

    const command = trace.launches[0]!.command;
    expect(command).toContain("--session-id");
    expect(command).toContain(ALLOCATED);
    expect(command).not.toContain("--resume");
    expect(command).toContain("--system-prompt-file");
  });

  it("CR3: one replay's live detach does not reach the next replay", function* () {
    // The two replays describe the same logical session and differ only in what
    // their journals retained. If the first one's live detach outlived the
    // launch that observed it, the second — whose journal proves the session
    // was already handed over — would create a second conversation under an
    // identity that already names one.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installReplay(harness, trace, routes, "prepared");
    yield* routes.publish(agreeing(retained()));

    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));
    trace.replay = { prepared: retained(), suffix: "prepared+detached" };
    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

    expect(trace.launches.length).toBe(2);
    expect(trace.launches[0]!.command).toContain("--session-id");
    expect(trace.launches[1]!.command).toEqual(["claude", "--resume", ALLOCATED]);
  });

  it("CR5: a route-store failure names a durable path, and the journal repeats none of it", function* () {
    // The store reaches a real filesystem, and a filesystem error says where it
    // was. That is host layout, and a launch record is not the place for it —
    // on either path that can meet one: a replay's read, and a fresh
    // publication's write.
    const marker = "xmd-route-root-3ae7";
    const faulty = (on: "read" | "publish"): AgentSessionRouteStore => {
      const inner = createMemorySessionRouteStore();
      return {
        *read(key) {
          if (on === "read") {
            throw new Error(`EACCES: /var/private/${marker}/routes/abc.json`);
          }
          return yield* inner.read(key);
        },
        *publish(candidate) {
          if (on === "publish") {
            throw new Error(`ENOSPC: /var/private/${marker}/routes/abc.json.staging`);
          }
          return yield* inner.publish(candidate);
        },
      };
    };

    // A replay, whose reconciliation reads the route.
    const replayTrace = newTrace();
    yield* installReplay(createFakeRuntime(), replayTrace, faulty("read"), "prepared");
    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

    // A fresh launch, whose preparation publishes one.
    const freshHarness = createFakeRuntime();
    const freshTrace = newTrace();
    yield* installLaunchStack(freshHarness, freshTrace, {
      adapters: { claude: ADAPTER },
      routeStore: faulty("publish"),
    });
    const refusal = yield* attempt(freshTrace, INSTRUCTIONS);

    for (const [name, trace] of [
      ["replay", replayTrace],
      ["fresh", freshTrace],
    ] as const) {
      const failed = trace.records.findLast((record) => record.failure);
      expect([name, failed?.failure?.class]).toEqual([name, "identity-unavailable"]);
      expect([name, JSON.stringify(trace.records).includes(marker)]).toEqual([name, false]);
      expect([name, trace.launches]).toEqual([name, []]);
    }
    expect(refusal?.message).not.toContain(marker);
  });

  it("CR4: disagreement refuses before each suffix's own first live phase", function* () {
    // Agreement is checked before this run does anything the next one would
    // have to live with. For a prepared-only replay that is the detach it is
    // about to retain — writing down that the handoff began is itself advancing
    // the launch. For a detached replay it is the spawn.
    const other = "99999999-0000-0000-0000-000000000000";
    const named = agreeing(retained()) as Extract<AgentSessionRouteV1, { route: "client-native" }>;
    // Each case is one way the journal and the route can describe different
    // sessions: a route that says something else, or a retained record another
    // provider wrote.
    const disagreements: [
      string,
      AgentSessionRouteV1 | undefined,
      Partial<PreparedLaunchRecord>,
    ][] = [
      ["no route at all", undefined, {}],
      ["another identity", { ...named, nativeSessionId: other }, {}],
      ["another instruction layer", { ...named, instructionsDigest: "c".repeat(64) }, {}],
      ["another launcher", { ...named, launcher: "codex" }, {}],
      ["an ACP-first route", acpFirst(), {}],
      // An agreeing ACPX route is not evidence that this provider owns the
      // session a different one prepared: that is two providers naming one
      // string.
      ["a record another provider prepared", agreeing(retained()), { provider: "other" }],
    ];

    for (const suffix of ["prepared", "prepared+detached"] as const) {
      for (const [name, planted, overrides] of disagreements) {
        const label = `${suffix}/${name}`;
        const harness = createFakeRuntime();
        const trace = newTrace();
        const routes = createMemorySessionRouteStore();
        yield* installReplay(harness, trace, routes, suffix, overrides);
        if (planted) {
          yield* routes.publish(planted);
        }

        yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

        // The phase it stopped at is the one whose first live effect it was
        // about to perform, and nothing after it ran.
        const stoppedAt = suffix === "prepared" ? "detached" : "exited";
        const failed = trace.records.findLast((record) => record.failure);
        expect([label, failed?.phase]).toEqual([label, stoppedAt]);
        expect([label, failed?.failure?.class]).toEqual([label, "identity-unavailable"]);
        if (suffix === "prepared") {
          // Stopped at the detach, so the journal never advanced past it.
          expect([label, trace.order]).toEqual([label, ["prepared", "detached"]]);
        }
        expect([label, trace.launches]).toEqual([label, []]);
        // No account was written to stand in for the one that disagreed.
        expect([label, yield* routes.read(KEY)]).toEqual([label, planted]);
      }
    }
  });
});

/**
 * Tier PF — what a private failure is allowed to say
 * (specs/native-agent-session-launch-spec.md §Instructions and native lifecycle).
 *
 * Everything on the setup and spawn path knows something the reader must not be
 * told: the private file's path, the argv, the host's own message about a file
 * nobody else can see. One normalizer at the boundary is what makes that true
 * once rather than at each site that could leak it.
 */
describe("Tier PF — normalized private failures", () => {
  /** The one message this boundary produces, read off a run that produced it. */
  function privateFailureMessage(trace: Trace): string | undefined {
    return (trace.records.findLast((record) => record.phase === "exited") as ExitedLaunchRecord)
      .failure?.message;
  }

  it("PF2: every shape of setup or spawn failure normalizes the same way", function* () {
    // The value a private path throws is not something this boundary may
    // reason about. A string, an object shaped like a settled failure, and an
    // Error carrying the real argv all say the same thing to a reader: nothing.
    const marker = "xmd-private-marker-4d90";
    const thrown: [string, unknown][] = [
      ["a string", `wrote ${marker} then failed`],
      ["a failure-shaped object", { class: "identity-unavailable", message: marker }],
      ["an Error carrying argv", new Error(`--system-prompt-file /tmp/${marker}/instructions.md`)],
      ["a value with no message at all", 42],
    ];

    for (const [name, value] of thrown) {
      const harness = createFakeRuntime();
      const trace = newTrace();
      yield* installLaunchStack(harness, trace, {
        routeStore: createMemorySessionRouteStore(),
        adapters: {
          claude: {
            launcher: "claude",
            identity: "client-allocated",
            allocate: () => "66666666-7777-8888-9999-000000000000",
            create: () => {
              throw value;
            },
            resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
          },
        },
      });

      yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

      const exited = trace.records.findLast(
        (record) => record.phase === "exited",
      ) as ExitedLaunchRecord;
      expect([name, exited.failure?.class]).toEqual([name, "process-creation-failed"]);
      expect([name, exited.failure?.message]).toEqual([name, privateFailureMessage(trace)]);
      expect([name, JSON.stringify(trace.records).includes(marker)]).toEqual([name, false]);
      expect([name, trace.launches]).toEqual([name, []]);
    }
  });

  it("PF3: an instruction write that fails leaves nothing behind", function* () {
    // Cleanup is registered before anything is written, so the directory is
    // removed whether the write finished, failed part-way, or never ran — and
    // it is removed while ownership is still held.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const directories: string[] = [];
    yield* installLaunchStack(harness, trace, {
      routeStore: createMemorySessionRouteStore(),
      adapters: {
        claude: {
          launcher: "claude",
          identity: "client-allocated",
          allocate: () => "77777777-8888-9999-0000-111111111111",
          create: (_id, instructionFile) => {
            // The file exists at this moment; the failure is what happens next.
            directories.push(dirname(instructionFile));
            throw new Error("the native process could not be prepared");
          },
          resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
        },
      },
    });

    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

    expect(directories.length).toBe(1);
    expect(
      yield* until(
        stat(directories[0]!).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    // And gone before ownership ended: the coordinator's release marker is
    // registered before the body runs, so every finalizer the body registers —
    // this cleanup among them — unwinds ahead of it.
    expect(trace.ownership.events.at(-1)).toBe("released-idle");
  });

  it("PF4: a real host failure names a private path, and none of it is repeated", function* () {
    // Not a planted throw: the host's own error, carrying the actual path this
    // launch was about to write its instructions into. That message is exactly
    // what a durable record must not carry, and what the normalizer replaces.
    const marker = "xmd-private-root-6b1c";
    const occupied = join(tmpdir(), `${marker}-${randomUUID()}`);
    yield* until(writeFile(occupied, "not a directory"));
    yield* ensure(function* () {
      yield* until(rm(occupied, { force: true }).catch(() => undefined));
    });

    const harness = createFakeRuntime();
    const trace = newTrace();
    const previous = process.env.TMPDIR;
    yield* installLaunchStack(harness, trace, {
      routeStore: createMemorySessionRouteStore(),
      adapters: {
        claude: {
          launcher: "claude",
          identity: "client-allocated",
          allocate: () => "88888888-9999-0000-1111-222222222222",
          create: (nativeSessionId, instructionFile) => [
            "claude",
            "--session-id",
            nativeSessionId,
            "--system-prompt-file",
            instructionFile,
          ],
          resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
        },
      },
    });

    // The private root is a file, so creating a directory under it fails in the
    // host's own words — before any instruction file can exist. Read and
    // written through `process.env`, which every runtime this file runs on
    // presents the same way; `node:os` resolves the private root from it.
    process.env.TMPDIR = occupied;
    try {
      yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
    }

    const exited = trace.records.findLast(
      (record) => record.phase === "exited",
    ) as ExitedLaunchRecord;
    expect(exited.failure?.class).toBe("process-creation-failed");
    expect(JSON.stringify(trace.records).includes(marker)).toBe(false);
    expect(exited.failure?.message).not.toContain(marker);
    expect(trace.launches).toEqual([]);
  });

  it("PF1: a planted host marker reaches neither the record nor the message", function* () {
    const marker = "xmd-private-marker-8f21";
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* installLaunchStack(harness, trace, {
      routeStore: createMemorySessionRouteStore(),
      adapters: {
        claude: {
          launcher: "claude",
          identity: "client-allocated",
          allocate: () => "33333333-4444-5555-6666-777777777777",
          create: () => {
            throw new Error(`spawning /private/${marker}/claude failed: ${marker}`);
          },
          resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
        },
      },
    });

    yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

    const exited = trace.records.findLast(
      (record) => record.phase === "exited",
    ) as ExitedLaunchRecord;
    expect(exited.failure?.class).toBe("process-creation-failed");
    expect(JSON.stringify(trace.records)).not.toContain(marker);
    expect(exited.failure?.message).not.toContain(marker);
    expect(trace.launches).toEqual([]);
  });
});

/**
 * Tier RR — which construction wins, and what the loser does
 * (specs/native-agent-session-launch-spec.md §Construction route).
 *
 * A session is constructed once, by one of two mechanisms, and the durable
 * route says which. Both can be reached by two provider scopes that share a
 * coordinator and a route namespace — a document opening an eager `<Session>`
 * while another run launches the same session natively. Publication is what
 * settles it, so both orders are exercised rather than only the one a scheduler
 * happened to produce. Nothing converts.
 */
describe("Tier RR — racing construction routes", () => {
  const ALLOCATED = "44444444-5555-6666-7777-888888888888";

  const ADAPTER: NativeAdapter = {
    launcher: "claude",
    identity: "client-allocated",
    allocate: () => ALLOCATED,
    create: (nativeSessionId, instructionFile) => [
      "claude",
      "--session-id",
      nativeSessionId,
      "--system-prompt-file",
      instructionFile,
    ],
    resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
  };

  interface Namespace {
    store: AcpSessionStore;
    shared: CoordinatorHarness;
    routes: AgentSessionRouteStore;
    /**
     * What ownership said at each route operation.
     *
     * The ordering claim is about *when* reconciliation happens, and reading
     * that off the production source is not evidence. The coordinator's own log
     * is: `owned` means an acquisition is live and has not been released.
     */
    during: string[];
  }

  function namespace(): Namespace {
    const shared = makeCoordinator();
    const inner = createMemorySessionRouteStore();
    const during: string[] = [];
    const witness = (what: string) => during.push(`${what}:${shared.events.at(-1) ?? "none"}`);
    return {
      store: makeStore(),
      shared,
      during,
      routes: {
        *read(key) {
          witness("read");
          return yield* inner.read(key);
        },
        *publish(candidate) {
          witness("publish");
          return yield* inner.publish(candidate);
        },
      },
    };
  }

  function* inScope<T>(
    space: Namespace,
    harness: FakeRuntimeHarness,
    trace: Trace,
    body: () => Operation<T>,
  ): Operation<T> {
    return yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, {
        adapters: { claude: ADAPTER },
        store: space.store,
        coordinator: space.shared.coordinator,
        routeStore: space.routes,
      });
      return yield* body();
    });
  }

  /**
   * Stage both contenders, then release the chosen winner first.
   *
   * The barrier is the point: neither construction may begin until both exist,
   * so which route wins cannot be an artifact of one scope having been built
   * later, and no provider-local state can be what decides it. The loser is
   * released once the winner has let ownership go — releasing both together
   * would prove something else, because the shared coordinator refuses
   * contention rather than queueing it.
   */
  function* race(
    space: Namespace,
    first: { harness: FakeRuntimeHarness; trace: Trace; body: () => Operation<unknown> },
    second: { harness: FakeRuntimeHarness; trace: Trace; body: () => Operation<unknown> },
  ): Operation<string[]> {
    return yield* scoped(function* () {
      const staged = { first: withResolvers<void>(), second: withResolvers<void>() };
      const gate = { first: withResolvers<void>(), second: withResolvers<void>() };
      const done = { first: withResolvers<void>(), second: withResolvers<void>() };
      const teardown = withResolvers<void>();

      const stage = (side: "first" | "second", contender: typeof first) =>
        inScope(space, contender.harness, contender.trace, function* () {
          staged[side].resolve();
          yield* gate[side].operation;
          try {
            yield* contender.body();
          } finally {
            done[side].resolve();
          }
          yield* teardown.operation;
        });

      const leader = yield* spawn(() => stage("first", first));
      const follower = yield* spawn(() => stage("second", second));

      yield* staged.first.operation;
      yield* staged.second.operation;
      expect(space.during).toEqual([]);

      gate.first.resolve();
      yield* done.first.operation;
      gate.second.resolve();
      yield* done.second.operation;
      const during = [...space.during];

      teardown.resolve();
      yield* leader;
      yield* follower;
      return during;
    });
  }

  function* routeOf(space: Namespace): Operation<AgentSessionRouteV1 | undefined> {
    return yield* space.routes.read({
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
    });
  }

  it("RR1: ACP-first wins, and the native launch refuses without converting", function* () {
    const space = namespace();
    const firstTrace = newTrace();
    const secondTrace = newTrace();

    const during = yield* race(
      space,
      {
        harness: createFakeRuntime(),
        trace: firstTrace,
        body: () => Agent.operations.session(),
      },
      {
        harness: createFakeRuntime(),
        trace: secondTrace,
        body: () => Agent.operations.launch(launchRequest(INSTRUCTIONS)),
      },
    );

    const published = yield* routeOf(space);
    expect(published?.route).toBe("acp-first");
    expect(secondTrace.records.findLast((record) => record.failure)?.failure?.class).toBe(
      "identity-unavailable",
    );
    expect(secondTrace.launches).toEqual([]);
    // One construction history, unchanged by the loser.
    expect(yield* routeOf(space)).toEqual(published);
    // Every read and publication happened inside a live acquisition.
    expect([during, during.every((entry) => entry.endsWith(":owned"))]).toEqual([during, true]);
  });

  it("RR2: client-native wins, and the eager session refuses in its own words", function* () {
    const space = namespace();
    const firstTrace = newTrace();
    const secondTrace = newTrace();
    let raised: Error | undefined;

    const during = yield* race(
      space,
      {
        harness: createFakeRuntime(),
        trace: firstTrace,
        body: () => Agent.operations.launch(launchRequest(INSTRUCTIONS)),
      },
      {
        harness: createFakeRuntime(),
        trace: secondTrace,
        body: function* () {
          try {
            yield* Agent.operations.session();
          } catch (error) {
            raised = error as Error;
          }
        },
      },
    );

    const published = yield* routeOf(space);
    expect(published?.route).toBe("client-native");
    // No launch was asked for, so no launch record fails: the provider says so
    // in its own typed error.
    expect(raised?.name).toBe("AgentSessionRouteError");
    expect(secondTrace.records).toEqual([]);
    expect(yield* routeOf(space)).toEqual(published);
    expect([during, during.every((entry) => entry.endsWith(":owned"))]).toEqual([during, true]);
  });
});

/**
 * Tier CX — cancellation finishes before ownership ends
 * (specs/native-agent-session-launch-spec.md §Ownership).
 *
 * Cancellation is not complete when the request to stop is made. It is complete
 * when the child can no longer act and the private file it was reading is gone
 * — and both have to be true while the coordinator still holds the session, or
 * the next owner is told the session is free while a UI is still in it.
 */
describe("Tier CX — cancellation before ownership ends", () => {
  it("CX1: the child settles and the private file is gone before ownership ends", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const hold = withResolvers<void>();
    const started = withResolvers<void>();
    let instructionFile = "";

    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, {
        routeStore: createMemorySessionRouteStore(),
        adapters: {
          claude: {
            launcher: "claude",
            identity: "client-allocated",
            allocate: () => "55555555-6666-7777-8888-999999999999",
            create: (nativeSessionId, instructionFile) => [
              "claude",
              "--session-id",
              nativeSessionId,
              "--system-prompt-file",
              instructionFile,
            ],
            resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
          },
        },
        hold: (function* () {
          started.resolve();
          yield* hold.operation;
        })(),
      });

      const launching = yield* spawn(() => Agent.operations.launch(launchRequest(INSTRUCTIONS)));
      yield* started.operation;

      // The child is active, and the layer it was given is a real file only
      // this process can read.
      const command = trace.launches[0]!.command;
      instructionFile = command[command.indexOf("--system-prompt-file") + 1]!;
      const info = yield* until(stat(instructionFile));
      expect(info.mode & 0o777).toBe(0o600);
      expect(yield* until(readFile(instructionFile, "utf8"))).toBe(INSTRUCTIONS);
      trace.ownership.events.push("cancelling");

      yield* launching.halt();
    });

    // Gone, and gone before ownership ended.
    expect(
      yield* until(
        stat(instructionFile).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    const released = trace.ownership.events.indexOf("released-active");
    expect(trace.ownership.events.indexOf("cancelling") < released).toBe(true);
    // A launch that stopped on the way never proved the session stopped, so it
    // stays owned rather than looking finished.
    expect(trace.ownership.events).not.toContain("quiesced");
  });
});

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
import { ensure, Ok, scoped, sleep, spawn, until, withResolvers } from "effection";
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
import type { NativeAdapter, NativeBinding } from "../src/native-launch.ts";
import { AgentSessionRouteError, createMemorySessionRouteStore } from "../src/session-route.ts";
import type { AgentSessionRoute, AgentSessionRouteStore } from "../src/session-route.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import {
  createFakeObserver,
  createFakeRuntime,
  makeCoordinator,
  makeRecord,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "./helpers.ts";
import type { CoordinatorHarness, FakeObserverHarness, FakeRuntimeHarness } from "./helpers.ts";
import type { ExecutableBuildBindingV1 } from "@executablemd/core";
import type { AcpxSessionPolicy } from "../src/provider.ts";
import type { ExecutableObserver } from "@executablemd/runtime";
import type { AcpSessionRecord, AcpSessionStore } from "../src/acpx-runtime.ts";

const CWD = "/work";
const AGENT_COMMAND = "claude-cmd";
const SESSION_KEY = deriveSessionKey(AGENT_COMMAND, CWD);

/**
 * A barrier on the directory an Agent runs in.
 *
 * The provider asks for it twice per operation: once to place the session, and
 * once while building the runtime that will ensure it. Parking each call and
 * releasing them by hand is what lets a case hold two operations inside the
 * same lookup suspension at once, deterministically, through a seam the
 * production path already has rather than one invented for a test.
 */
interface CwdBarrier {
  agentCwd: () => Operation<string>;
  /** Wait until at least `count` calls are parked. */
  waiting(count: number): Operation<void>;
  /** Let the `index`-th parked call, in arrival order, proceed. */
  release(index: number): void;
}

function createCwdBarrier(dir: string): CwdBarrier {
  const held: { resolve: () => void }[] = [];
  const watchers: { count: number; resolve: () => void }[] = [];

  function announce(): void {
    for (const watcher of [...watchers]) {
      if (held.length >= watcher.count) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  }

  return {
    agentCwd: () =>
      (function* (): Operation<string> {
        const gate = withResolvers<void>();
        held.push({ resolve: gate.resolve });
        announce();
        yield* gate.operation;
        return dir;
      })(),
    waiting: (count) =>
      (function* (): Operation<void> {
        if (held.length >= count) {
          return;
        }
        const reached = withResolvers<void>();
        watchers.push({ count, resolve: reached.resolve });
        yield* reached.operation;
      })(),
    release: (index) => held[index]?.resolve(),
  };
}

/**
 * The Claude-shaped build contract every controlled client-allocated adapter
 * here carries: which command to observe, what its version output means, and
 * what the ACP child needs in order to run that same build.
 */
const TEST_BINDING: NativeBinding = {
  command: "claude",
  // The same contract the shipped Claude adapter carries: exactly one canonical
  // line is an answer, and zero or several are not.
  version: (output) => {
    const canonical = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(line));
    return canonical.length === 1 ? canonical[0] : undefined;
  },
  environment: (livePath) => ({ CLAUDE_CODE_EXECUTABLE: livePath }),
};

/** What `createFakeObserver()`'s default observation binds to. */
const OBSERVED_BUILD: ExecutableBuildBindingV1 = {
  schema: "executable-build.v1",
  reportedVersion: "2.1.241 (Claude Code)",
  executableDigest: { algorithm: "sha256", value: "a".repeat(64) },
};

/** The canonical path that same observation reports. */
const OBSERVED_PATH = "/opt/builds/claude";

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
  /** Advertised for client-native attachment; defaults to `advertise`. */
  attach?: readonly string[];
  /** `false` gives this host no way to observe a build at all. */
  observer?: ExecutableObserver | false;
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
  /** Host-owned session placement and retention, as a workflow host supplies. */
  sessions?: AcpxSessionPolicy;
  /**
   * The directory an Agent runs in.
   *
   * The provider resolves this while building a runtime, so an injected one is
   * a real seam into that lookup rather than a hook added for a test.
   */
  agentCwd?: () => Operation<string>;
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
    // These suites route launches, never a `<Session>` placement. Throwing
    // rather than answering means a placement that did reach here fails
    // loudly instead of being handed an identity nobody derived.
    sessionIdentity: () => {
      throw new Error("this stub authority routes no session placement");
    },
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
    advertiseClientNativeAttachment: options.attach ?? options.advertise ?? ["claude"],
    ...(options.observer === false
      ? {}
      : { executableObserver: options.observer ?? createFakeObserver().observer }),
    coordinator: options.coordinator ?? trace.ownership.coordinator,
    ...(options.routeStore ? { routeStore: options.routeStore } : {}),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.agentCwd ? { agentCwd: options.agentCwd } : {}),
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
      // and nothing was spawned. The ACP connection to it does not survive the
      // refusal: nothing will detach this session, so holding one open until
      // teardown would leave a child alive for the rest of the document.
      expect(harness.ensureCalls.length).toBe(1);
      expect(harness.closeCalls.length).toBe(1);
      expect(trace.launches.length).toBe(0);
    });

    // And once, through the runtime that made it. A handle only the managed map
    // knew about is one teardown closes a second time or not at all, and the
    // index says which runtime each close actually went through.
    expect(harness.closeCalls.length).toBe(1);
    expect(harness.createdOptions.length).toBe(1);
    expect(harness.closeRuntimeIndexes).toEqual([0]);
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
      // One ensure, one failed close, and nothing since.
      expect(harness.ensureCalls.length).toBe(1);
      expect(harness.closeCalls.length).toBe(1);
      // Let this provider's own teardown release what it is still holding.
      harness.closeFailure = undefined;
    });

    // Teardown found it. A handle a detach could not release is still this
    // provider's, whichever path created it — a provider-returned launch keeps
    // the same ownership account an attachment does, or teardown closes through
    // a runtime that did not make it, or does not reach it at all.
    expect(harness.closeCalls.length).toBe(2);
    expect(harness.createdOptions.length).toBe(1);
    expect(harness.closeRuntimeIndexes).toEqual([0, 0]);
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
          // The close failed, so it released nothing: the entry this scope
          // holds is still the live one, still bound to the runtime that made
          // it, and still the only close attempted so far.
          seen.closesSoFar = harness.closeCalls.length;

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
          closesSoFar: 1,
        },
      ]);
      // And teardown found that exact handle again, through the same runtime
      // that created it — the availability probe builds one of its own, so what
      // matters is that both closes went through one and the same. A failed
      // release that had detached the placement, or dropped the entry, would
      // leave nothing here to close.
      expect([site, harness.closeCalls.length]).toEqual([site, 2]);
      expect([site, new Set(harness.closeRuntimeIndexes).size]).toEqual([site, 1]);
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
      binding: TEST_BINDING,
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

  function* routeOf(store: AgentSessionRouteStore): Operation<AgentSessionRoute | undefined> {
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
    // A new client-native session publishes the bound form: the identity XMD
    // chose, beside the build that was observed accepting it.
    expect(route).toEqual({
      schema: "session-route.v2",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
      nativeSessionId: ALLOCATED,
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      launcher: "claude",
      executableBinding: OBSERVED_BUILD,
    });
    expect(prepared.executableBinding).toEqual(OBSERVED_BUILD);
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
    // The exact file that was observed, not the name the adapter writes: the
    // name is what durable records carry, and this is what the run spawns.
    expect(command[0]).toBe(OBSERVED_PATH);
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
    expect(trace.launches[1]!.command).toEqual([OBSERVED_PATH, "--resume", ALLOCATED]);
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

  it("CN8: a Session on a bound client-native route attaches to the identity it already has", function* () {
    // Attachment, never conversion: the route stays client-native, the session
    // ACP joins is the one the native process was told to make, and the
    // identity crosses as an exact resume rather than being created under.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* installClientNative(harness, trace, { routeStore: routes });
    yield* launch(INSTRUCTIONS);
    const before = yield* routeOf(routes);

    const session = yield* Agent.operations.session();

    expect(harness.ensureCalls.at(-1)?.resumeSessionId).toBe(ALLOCATED);
    expect(session.agentSessionId).toBe(ALLOCATED);
    // Nothing republished, nothing converted, and no second identity.
    expect(yield* routeOf(routes)).toEqual(before);
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
    binding: TEST_BINDING,
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
      executableBinding: OBSERVED_BUILD,
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
  function acpFirst(): AgentSessionRoute {
    return {
      schema: "session-route.v1",
      route: "acp-first",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
    };
  }

  /** The route that agrees with it. */
  function agreeing(record: PreparedLaunchRecord): AgentSessionRoute {
    return {
      schema: "session-route.v2",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: record.sessionKey,
      nativeSessionId: record.nativeSessionId,
      identityProvenance: "client-allocated",
      instructionsDigest: record.instructionsDigest,
      launcher: record.launcher,
      executableBinding: record.executableBinding ?? OBSERVED_BUILD,
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

    expect(trace.launches[0]!.command).toEqual([OBSERVED_PATH, "--resume", ALLOCATED]);
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
    expect(trace.launches[1]!.command).toEqual([OBSERVED_PATH, "--resume", ALLOCATED]);
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
    const named = agreeing(retained()) as Extract<
      AgentSessionRoute,
      { schema: "session-route.v2" }
    >;
    // Each case is one way the journal and the route can describe different
    // sessions: a route that says something else, or a retained record another
    // provider wrote.
    const disagreements: [string, AgentSessionRoute | undefined, Partial<PreparedLaunchRecord>][] =
      [
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
            binding: TEST_BINDING,
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
          binding: TEST_BINDING,
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
          binding: TEST_BINDING,
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
          binding: TEST_BINDING,
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
    binding: TEST_BINDING,
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

  function* routeOf(space: Namespace): Operation<AgentSessionRoute | undefined> {
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

  it("RR2: client-native wins, and the eager session attaches to its identity", function* () {
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
    // The loser adopts the winner's account rather than replacing it: the
    // eager session attaches to the conversation the launch named, and no
    // launch record was authored because none was asked for.
    expect(raised).toBe(undefined);
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
            binding: TEST_BINDING,
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

/**
 * Tier CA — attaching ACP to a session a native process constructed
 * (specs/native-agent-session-launch-spec.md §Provider-native identity).
 *
 * Attachment, never conversion. The route stays client-native, the identity
 * crosses unchanged as an exact resume, and the provider has to say it opened
 * that same conversation before a turn may start. Every way it cannot — no
 * advertised capability, no observer, a different build, provider arrangement
 * that names something else, an attachment that answers with another session —
 * fails closed before the turn it would make unsafe.
 */
describe("Tier CA — client-native attachment", () => {
  const ALLOCATED = "44444444-5555-6666-7777-888888888888";
  /** A second session bound to the same build, for what a refusal leaves behind. */
  const SECOND_ALLOCATED = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

  function adapter(): NativeAdapter {
    return {
      launcher: "claude",
      identity: "client-allocated",
      binding: TEST_BINDING,
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
  }

  const KEY = { provider: "acpx", agent: AGENT_COMMAND, sessionKey: SESSION_KEY };

  /** The bound route a native launch leaves behind. */
  function bound(overrides: Partial<AgentSessionRouteV2Shape> = {}): AgentSessionRoute {
    return {
      schema: "session-route.v2",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
      nativeSessionId: ALLOCATED,
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      launcher: "claude",
      executableBinding: OBSERVED_BUILD,
      ...overrides,
    };
  }

  type AgentSessionRouteV2Shape = Extract<AgentSessionRoute, { schema: "session-route.v2" }>;

  /** The same session as the released unbound contract published it. */
  function legacy(): AgentSessionRoute {
    return {
      schema: "session-route.v1",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
      nativeSessionId: ALLOCATED,
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      launcher: "claude",
    };
  }

  interface Attached {
    harness: FakeRuntimeHarness;
    trace: Trace;
    routes: AgentSessionRouteStore;
    observer: FakeObserverHarness;
    store: ReturnType<typeof makeStore>;
  }

  function* installAttachment(
    published: AgentSessionRoute | undefined,
    options: ProviderOptions & { observer?: ExecutableObserver | false } = {},
  ): Operation<Attached> {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    const store = makeStore();
    if (published) {
      yield* routes.publish(published);
    }
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      store,
      observer: options.observer === undefined ? observer.observer : options.observer,
      ...options,
    });
    return { harness, trace, routes, observer, store };
  }

  /** What a Session attempt raised, or nothing. */
  function* attach(): Operation<Error | undefined> {
    try {
      yield* Agent.operations.session();
      return undefined;
    } catch (error) {
      return error as Error;
    }
  }

  it("CA1: the route's exact identity crosses as resumeSessionId, with the observed build", function* () {
    const space = yield* installAttachment(bound());

    const session = yield* Agent.operations.session();

    // The identity the route names, unchanged. Never an ACP session id, an
    // ACPX record id, or anything that merely looks like a UUID.
    expect(space.harness.ensureCalls).toHaveLength(1);
    expect(space.harness.ensureCalls[0]?.resumeSessionId).toBe(ALLOCATED);
    expect(session.agentSessionId).toBe(ALLOCATED);
    // The build was reobserved before the runtime existed, and the exact path
    // it found reaches only the matching child's transient environment.
    expect(space.observer.observed).toEqual(["claude"]);
    const options = space.harness.createdOptions.at(-1);
    expect(options?.agentProcessEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: OBSERVED_PATH });
    // And nowhere else.
    expect(JSON.stringify(yield* space.routes.read(KEY))).not.toContain(OBSERVED_PATH);
    expect(JSON.stringify(space.trace.records)).not.toContain(OBSERVED_PATH);
  });

  it("CA2: a subscribed Prompt attaches under the same identity", function* () {
    const space = yield* installAttachment(bound());

    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt("continue", {});
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      expect(next.value).toBe("hello world");
    });

    expect(space.harness.ensureCalls[0]?.resumeSessionId).toBe(ALLOCATED);
    expect(space.harness.turns).toHaveLength(1);
    // The turn ran through the child that was given the bound executable.
    expect(space.harness.turns[0]?.input.handle.agentSessionId).toBe(ALLOCATED);
  });

  it("CA3: an unadvertised attachment gate refuses before ensure", function* () {
    // Knowing how to hand a session to a native UI is not evidence that this
    // build can join the conversation afterwards. The two are separate
    // choices, and neither is inferred from the other.
    const space = yield* installAttachment(bound(), { advertise: ["claude"], attach: [] });

    const raised = yield* attach();

    expect(raised?.message).toContain("not advertised as able to attach");
    expect(space.harness.ensureCalls).toEqual([]);
    expect(space.harness.turns).toEqual([]);
  });

  it("CA4: a host that cannot observe a build refuses before any provider effect", function* () {
    const space = yield* installAttachment(bound(), { observer: false });

    const raised = yield* attach();

    expect(raised?.message).toContain("executable build observation");
    expect(space.harness.ensureCalls).toEqual([]);
    expect(space.harness.createdOptions).toEqual([]);
  });

  it("CA5: a build this run cannot name, or cannot reach, refuses before ensure", function* () {
    for (const [name, mutate] of [
      [
        "another build at the same command",
        (observer: FakeObserverHarness) => {
          observer.observation.digest = "b".repeat(64);
        },
      ],
      [
        "another version of the same bytes",
        (observer: FakeObserverHarness) => {
          observer.observation.versionOutput = "2.1.242 (Claude Code)\n";
        },
      ],
      [
        "output this adapter does not recognize",
        (observer: FakeObserverHarness) => {
          observer.observation.versionOutput = "claude version 2.1.241\n";
        },
      ],
      [
        "an executable that could not be observed at all",
        (observer: FakeObserverHarness) => {
          observer.failure = "not-executable";
        },
      ],
    ] as const) {
      yield* scoped(function* () {
        const observer = createFakeObserver();
        mutate(observer);
        const space = yield* installAttachment(bound(), { observer: observer.observer });

        const raised = yield* attach();

        expect([name, raised === undefined]).toEqual([name, false]);
        expect([name, space.harness.ensureCalls]).toEqual([name, []]);
        // A moved build is still that build, so nothing here may name a path.
        expect([name, raised?.message.includes(OBSERVED_PATH)]).toEqual([name, false]);
      });
    }
  });

  it("CA6: a moved build is the same build", function* () {
    // Equality is over what was retained — a version and a digest — so the same
    // bytes reached at another path attach exactly as they would have before.
    const observer = createFakeObserver({ path: "/elsewhere/bin/claude" });
    const space = yield* installAttachment(bound(), { observer: observer.observer });

    const session = yield* Agent.operations.session();

    expect(session.agentSessionId).toBe(ALLOCATED);
    expect(space.harness.createdOptions.at(-1)?.agentProcessEnv).toEqual({
      CLAUDE_CODE_EXECUTABLE: "/elsewhere/bin/claude",
    });
  });

  it("CA7: retained provider arrangement that names something else refuses before ensure", function* () {
    for (const [name, asserted] of [
      ["another conversation", "99999999-0000-0000-0000-000000000000"],
      ["no conversation at all", undefined],
    ] as const) {
      yield* scoped(function* () {
        const store = makeStore();
        const record = makeRecord(AGENT_COMMAND, CWD);
        record.acpxRecordId = SESSION_KEY;
        if (asserted !== undefined) {
          record.agentSessionId = asserted;
        }
        store.records.set(SESSION_KEY, record);
        const space = yield* installAttachment(bound(), { store });

        const raised = yield* attach();

        expect([name, raised === undefined]).toEqual([name, false]);
        expect([name, space.harness.ensureCalls]).toEqual([name, []]);
        expect([name, space.harness.turns]).toEqual([name, []]);
      });
    }
  });

  it("CA8: an attachment that opened another conversation is closed before a turn", function* () {
    // The last check, and the one nothing before it can make: what the provider
    // says it loaded. A turn taken through this handle would land in history
    // that is not this session's.
    const space = yield* installAttachment(bound());
    space.harness.assertIdentity = "00000000-1111-2222-3333-444444444444";

    const raised = yield* attach();

    expect(raised?.message).toContain("did not report");
    expect(space.harness.ensureCalls).toHaveLength(1);
    expect(space.harness.closeCalls).toHaveLength(1);
    expect(space.harness.turns).toEqual([]);
  });

  it("CA8b: a provider that cannot open the named conversation refuses in one class", function* () {
    // Missing history and an adapter that cannot resume by name are the same
    // answer: the conversation this session names is not reachable. The
    // adapter's own message would carry provider-private detail, so the stable
    // class is what crosses — and nothing was created in its place.
    const space = yield* installAttachment(bound());
    space.harness.ensureFailure = new Error(
      "No conversation found with session ID /home/operator/.claude/projects/x",
    );

    const raised = yield* attach();

    expect(raised?.message).toContain("could not open");
    expect(raised?.message).not.toContain("/home/operator");
    expect(space.harness.turns).toEqual([]);
    expect([...space.store.records.keys()]).toEqual([]);
  });

  it("CA11: a rejected exact resume leaves no partition for the next attempt", function* () {
    // The runtime is built before the ensure that would use it, so an ensure
    // that rejects leaves one holding a live path for work that never happened.
    // A binding compares a version and a digest, so the same build found
    // somewhere else is the same partition key and a different file to run —
    // and handing the next attachment the old path is how it would run one.
    const observer = createFakeObserver();
    observer.queued = [
      { path: OBSERVED_PATH, digest: "a".repeat(64), versionOutput: "2.1.241 (Claude Code)\n" },
      {
        path: "/moved/bin/claude",
        digest: "a".repeat(64),
        versionOutput: "2.1.241 (Claude Code)\n",
      },
    ];
    const space = yield* installAttachment(bound(), { observer: observer.observer });
    // A second session bound to the same build, so what the next attachment
    // reaches for is the same partition. It is a different session because the
    // refusal below withholds quiescence, and a session whose owner never
    // proved it stopped is one the coordinator refuses — a different contract,
    // asserted by CA12.
    const second = deriveSessionKey(AGENT_COMMAND, CWD, "second");
    yield* space.routes.publish(bound({ sessionKey: second, nativeSessionId: SECOND_ALLOCATED }));
    space.harness.ensureFailure = new Error("No conversation found with that session ID");

    const refused = yield* attach();
    expect(refused?.message).toContain("could not open");

    // The same build, found somewhere else. Nothing is reused: this attachment
    // observes again and builds its own runtime around what it found.
    space.harness.ensureFailure = undefined;
    const session = yield* Agent.operations.session("second");

    expect(session.agentSessionId).toBe(SECOND_ALLOCATED);
    expect(observer.observed).toEqual(["claude", "claude"]);
    expect(
      space.harness.createdOptions.map(
        (options) => options.agentProcessEnv?.CLAUDE_CODE_EXECUTABLE,
      ),
    ).toEqual([OBSERVED_PATH, "/moved/bin/claude"]);
  });

  it("CA12: a Prompt whose mismatch could not be closed acknowledges nothing", function* () {
    // A subscribed Prompt acknowledges quiescence from a finalizer, so it runs
    // on the way out of a refusal as readily as out of a turn. Two things had
    // happened by then: the attachment named another conversation, and giving
    // the handle up did not work. That handle never became a usable session, so
    // nothing a caller can reach knows about it — and it is still a live thing
    // this owner started, which is the whole of what quiescence is a claim
    // about.
    let harness: FakeRuntimeHarness | undefined;
    let trace: Trace | undefined;
    let teardown: Error | undefined;

    try {
      yield* scoped(function* () {
        const space = yield* installAttachment(bound());
        harness = space.harness;
        trace = space.trace;
        space.harness.assertIdentity = "00000000-1111-2222-3333-444444444444";
        space.harness.closeFailure = new Error("the agent child did not answer the close");

        let refused: Error | undefined;
        try {
          yield* scoped(function* () {
            const stream = yield* Agent.operations.prompt("continue", {});
            const subscription = yield* stream;
            yield* subscription.next();
          });
        } catch (error) {
          refused = error as Error;
        }

        expect(refused?.message).toContain("did not report");
        // Attempted in band, and it failed. No turn was ever started.
        expect(space.harness.closeCalls).toHaveLength(1);
        expect(space.harness.turns).toEqual([]);

        // The next owner is told the session needs recovery, and is told it
        // before contacting the agent: the ensure count has not moved.
        const ensures = space.harness.ensureCalls.length;
        let next: Error | undefined;
        try {
          yield* Agent.operations.session();
        } catch (error) {
          next = error as Error;
        }
        expect(next?.name).toBe("AgentSessionRecoveryRequired");
        expect(space.harness.ensureCalls.length).toBe(ensures);
      });
    } catch (error) {
      // Teardown reports what it could not settle rather than swallowing it.
      teardown = error as Error;
    }

    // Nothing acknowledged that this owner had finished with the session.
    expect(trace?.ownership.events).toContain("owned");
    expect(trace?.ownership.events).not.toContain("quiesced");
    // And teardown found the handle again, through its creating partition.
    expect(harness?.closeCalls).toHaveLength(2);
    expect(harness?.closeRuntimes).toEqual([OBSERVED_PATH, OBSERVED_PATH]);
    expect(harness?.closeRuntimeIndexes).toEqual([0, 0]);
    expect(teardown).toBeInstanceOf(Error);
  });

  /**
   * One subscribed Prompt, halted with its ensure still in flight.
   *
   * `ensureSession()` runs whether or not anybody is waiting, so a cancellation
   * here is not the end of the story: the provider may still answer. These
   * cases drive the gate to each of its two endings and watch what the halt did
   * about them — in effects rather than in timing, because what matters is that
   * the answer was observed and settled, not how long the halt took.
   */
  function* haltedMidEnsure(
    space: Attached,
    gate: { operation: Operation<void>; resolve: () => void; reject: (error: Error) => void },
  ): Operation<void> {
    const arrived = withResolvers<void>();
    space.harness.ensureGate = (input) => {
      if (input.sessionKey !== SESSION_KEY) {
        return undefined;
      }
      arrived.resolve();
      return gate.operation;
    };

    const prompt = yield* spawn(() =>
      scoped(function* () {
        const stream = yield* Agent.operations.prompt("continue", {});
        const subscription = yield* stream;
        yield* subscription.next();
      }),
    );
    yield* arrived.operation;
    yield* spawn(() => prompt.halt());
    // Long enough for a halt that walked away from the ensure to have finished
    // doing so, and for anything it wrongly settled to be visible.
    yield* sleep(50);
  }

  it("CA15: a halt waits for the ensure it started, and closes what it answers with", function* () {
    const space = yield* installAttachment(bound());
    const gate = withResolvers<void>();

    yield* haltedMidEnsure(space, gate);

    // Nothing has been settled: the ensure has not answered, so there is no
    // handle to close and nothing may yet tell the coordinator this owner is
    // done with the session.
    expect(space.harness.closeCalls).toEqual([]);
    expect(space.trace.ownership.events).not.toContain("quiesced");

    // It answers. The handle belongs to this provider whether or not anybody is
    // still waiting for it, so it is closed — through the runtime that made it
    // — and only then is this owner finished.
    gate.resolve();
    yield* sleep(50);

    expect(space.harness.closeCalls).toHaveLength(1);
    expect(space.harness.closeRuntimeIndexes).toEqual([0]);
    expect(space.harness.closeRuntimes).toEqual([OBSERVED_PATH]);
    // Nothing was ever said in it.
    expect(space.harness.turns).toEqual([]);
    expect(space.trace.ownership.events).toContain("quiesced");

    // The close settled, so the next owner is granted rather than told to
    // recover a session an unfinished cancellation may still be in.
    space.harness.ensureGate = undefined;
    const next = yield* Agent.operations.session();
    expect(next.agentSessionId).toBe(ALLOCATED);
  });

  it("CA16: a halted ensure that then fails gives its claim back", function* () {
    const observer = createFakeObserver();
    observer.queued = [
      { path: OBSERVED_PATH, digest: "a".repeat(64), versionOutput: "2.1.241 (Claude Code)\n" },
      {
        path: "/moved/bin/claude",
        digest: "a".repeat(64),
        versionOutput: "2.1.241 (Claude Code)\n",
      },
    ];
    const space = yield* installAttachment(bound(), { observer: observer.observer });
    const second = deriveSessionKey(AGENT_COMMAND, CWD, "second");
    yield* space.routes.publish(bound({ sessionKey: second, nativeSessionId: SECOND_ALLOCATED }));
    const gate = withResolvers<void>();

    yield* haltedMidEnsure(space, gate);

    // It answers with nothing at all. There is no handle to close and no claim
    // to keep, so the partition it was standing on goes with it.
    gate.reject(new Error("No conversation found with that session ID"));
    yield* sleep(50);

    expect(space.harness.closeCalls).toEqual([]);
    expect(space.harness.turns).toEqual([]);

    // A later attachment observes again and builds its own runtime around what
    // it finds, rather than inheriting a path nothing is holding.
    space.harness.ensureGate = undefined;
    const later = yield* Agent.operations.session("second");
    expect(later.agentSessionId).toBe(SECOND_ALLOCATED);
    expect(observer.observed).toEqual(["claude", "claude"]);
    expect(
      space.harness.createdOptions.map(
        (options) => options.agentProcessEnv?.CLAUDE_CODE_EXECUTABLE,
      ),
    ).toEqual([OBSERVED_PATH, "/moved/bin/claude"]);
  });

  it("CA17: a released session keeps its name and nothing live", function* () {
    // `<Session>` releases its handle as it returns, so what the returned value
    // still resolves to is placement metadata — not the handle, and not the
    // runtime that carries the transient child environment and therefore the
    // canonical executable path. Reusing it re-ensures, and the observation
    // that goes with it is a fresh one: a value that still named a runtime
    // would answer from the path that runtime was built with.
    const observer = createFakeObserver();
    observer.queued = [
      { path: OBSERVED_PATH, digest: "a".repeat(64), versionOutput: "2.1.241 (Claude Code)\n" },
      {
        path: "/moved/bin/claude",
        digest: "a".repeat(64),
        versionOutput: "2.1.241 (Claude Code)\n",
      },
    ];
    const space = yield* installAttachment(bound(), { observer: observer.observer });

    const session = yield* Agent.operations.session();
    expect(session.agentSessionId).toBe(ALLOCATED);
    // Released on the way out, and released successfully.
    expect(space.harness.closeCalls).toHaveLength(1);
    expect(space.trace.ownership.events).toContain("quiesced");

    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt("continue", { session });
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });

    // The same conversation, reached again — by observing the build afresh and
    // building a runtime around what that observation found.
    expect(observer.observed).toEqual(["claude", "claude"]);
    expect(space.harness.ensureCalls).toHaveLength(2);
    expect(space.harness.ensureCalls[1]?.resumeSessionId).toBe(ALLOCATED);
    expect(
      space.harness.createdOptions.map(
        (options) => options.agentProcessEnv?.CLAUDE_CODE_EXECUTABLE,
      ),
    ).toEqual([OBSERVED_PATH, "/moved/bin/claude"]);
  });

  it("CA13: a host that cannot retain the session gives the handle back to its creator", function* () {
    // The ensure succeeded, so the handle is this provider's whatever happens
    // next. A host refusing to retain what the session is leaves it unusable,
    // not unowned.
    let retentions = 0;
    const space = yield* installAttachment(bound(), {
      sessions: {
        // deno-lint-ignore require-yield
        *place(context) {
          const named = typeof context.session === "string" ? context.session : undefined;
          return { sessionKey: deriveSessionKey(AGENT_COMMAND, CWD, named), cwd: CWD };
        },
        // deno-lint-ignore require-yield
        *established() {
          retentions += 1;
          if (retentions === 1) {
            throw new Error("the run could not retain this session");
          }
        },
      },
    });
    const second = deriveSessionKey(AGENT_COMMAND, CWD, "second");
    yield* space.routes.publish(bound({ sessionKey: second, nativeSessionId: SECOND_ALLOCATED }));

    const raised = yield* attach();

    expect(raised?.message).toContain("could not retain");
    // Closed through the runtime that made it, and closed exactly once.
    expect(space.harness.closeCalls).toHaveLength(1);
    expect(space.harness.closeRuntimes).toEqual([OBSERVED_PATH]);
    expect(space.harness.turns).toEqual([]);

    // The accounting came back with it. A partition still counting a handle
    // nobody holds would be reused here instead of rebuilt, so a second
    // runtime is what says the count reached zero.
    const session = yield* Agent.operations.session("second");
    expect(session.agentSessionId).toBe(SECOND_ALLOCATED);
    expect(space.harness.createdOptions).toHaveLength(2);
  });

  it("CA14: output naming several builds refuses before a child, an ensure or a turn", function* () {
    // One canonical line is an answer. Several is a list of builds, and taking
    // the first would be choosing one — which is the question this refuses.
    const observer = createFakeObserver({
      versionOutput: "2.1.241 (Claude Code)\n2.1.242 (Claude Code)\n",
    });
    const space = yield* installAttachment(bound(), { observer: observer.observer });

    const raised = yield* attach();

    expect(raised?.message).toContain("does not recognize");
    // Nothing was repeated back: the output is the provider's, not the reader's.
    expect(raised?.message).not.toContain("2.1.242");
    expect(space.harness.createdOptions).toEqual([]);
    expect(space.harness.ensureCalls).toEqual([]);
    expect(space.harness.turns).toEqual([]);
    expect(space.trace.launches).toEqual([]);
  });

  it("CA9: a legacy unbound route refuses rather than attaching", function* () {
    // Constructed before XMD recorded which build accepted the identity. A
    // build observed now says which one is installed today, not which one has
    // this conversation, so there is nothing to compare and nothing to join.
    const space = yield* installAttachment(legacy());

    const raised = yield* attach();

    expect(raised?.message).toContain("before XMD recorded which build");
    expect(space.harness.ensureCalls).toEqual([]);
    expect(space.harness.createdOptions).toEqual([]);
    // The route is left exactly as it was: not upgraded, not supplemented.
    expect(yield* space.routes.read(KEY)).toEqual(legacy());
  });

  it("CA10: a route this build cannot read reaches no provider work", function* () {
    const routes: AgentSessionRouteStore = {
      // deno-lint-ignore require-yield
      *read(): Operation<AgentSessionRoute | undefined> {
        throw new AgentSessionRouteError("the construction route record is not readable");
      },
      // deno-lint-ignore require-yield
      *publish(candidate) {
        return candidate;
      },
    };
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
    });

    const raised = yield* attach();

    expect(raised?.name).toBe("AgentSessionRouteError");
    expect(harness.ensureCalls).toEqual([]);
    expect(harness.createdOptions).toEqual([]);
  });
});

/**
 * Tier RT — one runtime per agent command and build
 * (specs/acp-client-spec.md §ACPX provider).
 *
 * A child running the wrong build accepts the session identity and disagrees
 * silently about what it names, so sessions bound to different builds never
 * share one. A partition holds a live executable path for the work it owns, and
 * when the last handle it made closes it is gone rather than kept for nobody.
 */
describe("Tier RT — bound runtime partitions", () => {
  const FIRST = "aaaaaaaa-1111-2222-3333-444444444444";
  const SECOND = "bbbbbbbb-1111-2222-3333-444444444444";
  const THIRD = "cccccccc-1111-2222-3333-444444444444";
  const FOURTH = "dddddddd-1111-2222-3333-444444444444";

  function adapter(): NativeAdapter {
    return {
      launcher: "claude",
      identity: "client-allocated",
      binding: TEST_BINDING,
      allocate: () => FIRST,
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

  function route(sessionKey: string, id: string, binding = OBSERVED_BUILD): AgentSessionRoute {
    return {
      schema: "session-route.v2",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey,
      nativeSessionId: id,
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      launcher: "claude",
      executableBinding: binding,
    };
  }

  /** The environments every runtime this harness built was given. */
  function environments(harness: FakeRuntimeHarness): (string | undefined)[] {
    return harness.createdOptions.map((options) => options.agentProcessEnv?.CLAUDE_CODE_EXECUTABLE);
  }

  it("RT1: the last close evicts the partition, and later work reobserves", function* () {
    // Each `<Session>` releases its handle as it returns, so the partition it
    // built goes with it. The next attachment observes again and builds
    // another, rather than reusing a path nobody is holding.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    yield* routes.publish(route(SESSION_KEY, FIRST));
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      observer: observer.observer,
    });

    yield* Agent.operations.session();
    yield* Agent.operations.session();

    expect(observer.observed).toEqual(["claude", "claude"]);
    expect(environments(harness)).toEqual([OBSERVED_PATH, OBSERVED_PATH]);
    // Each handle was closed through the runtime that created it.
    expect(harness.closeCalls).toHaveLength(2);
  });

  it("RT2: a different build never shares a child", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    yield* routes.publish(route(SESSION_KEY, FIRST));
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      observer: observer.observer,
    });

    yield* Agent.operations.session();
    // The same command, a different build behind it, and a route that names
    // the old one: the attachment refuses rather than reusing the child.
    observer.observation.digest = "c".repeat(64);
    observer.observation.path = "/opt/builds/other-claude";
    let raised: Error | undefined;
    try {
      yield* Agent.operations.session();
    } catch (error) {
      raised = error as Error;
    }

    expect(raised?.message).toContain("cannot be confirmed");
    // One runtime, for the one build that was ever accepted.
    expect(environments(harness)).toEqual([OBSERVED_PATH]);
  });

  it("RT3: each handle is closed by the partition that created it", function* () {
    // Two sessions, two builds, two children. The only thing that tells the
    // runtimes apart is the transient environment each was built with, which is
    // exactly what a close has to reach.
    const other: ExecutableBuildBindingV1 = {
      schema: "executable-build.v1",
      reportedVersion: "2.1.242 (Claude Code)",
      executableDigest: { algorithm: "sha256", value: "d".repeat(64) },
    };
    const OTHER_PATH = "/opt/builds/claude-2";
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    observer.queued = [
      { path: OBSERVED_PATH, digest: "a".repeat(64), versionOutput: "2.1.241 (Claude Code)\n" },
      { path: OTHER_PATH, digest: "d".repeat(64), versionOutput: "2.1.242 (Claude Code)\n" },
    ];
    const second = deriveSessionKey(AGENT_COMMAND, CWD, "second");
    yield* routes.publish(route(SESSION_KEY, FIRST));
    yield* routes.publish(route(second, SECOND, other));
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      observer: observer.observer,
    });

    yield* Agent.operations.session();
    yield* Agent.operations.session("second");

    expect(environments(harness)).toEqual([OBSERVED_PATH, OTHER_PATH]);
    expect(harness.closeRuntimes).toEqual([OBSERVED_PATH, OTHER_PATH]);
  });

  it("RT5: work in flight keeps its partition, and a failure beside it releases only its own claim", function* () {
    // A runtime is claimed before the ensure that would use it, so between
    // those two moments the partition is standing on work rather than on a
    // handle. A sibling ensure failing there must give up its own claim and
    // nothing else: evicting while the first is still talking is how a second
    // child gets built for a build the first has open.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    const held = deriveSessionKey(AGENT_COMMAND, CWD, "held");
    const failing = deriveSessionKey(AGENT_COMMAND, CWD, "failing");
    const later = deriveSessionKey(AGENT_COMMAND, CWD, "later");
    yield* routes.publish(route(held, FIRST));
    yield* routes.publish(route(failing, SECOND));
    yield* routes.publish(route(later, THIRD));
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      observer: observer.observer,
    });

    const gate = withResolvers<void>();
    const arrived = withResolvers<void>();
    harness.ensureGate = (input) => {
      if (input.sessionKey === held) {
        arrived.resolve();
        return gate.operation;
      }
      if (input.sessionKey === failing) {
        return (function* (): Operation<void> {
          throw new Error("No conversation found with that session ID");
        })();
      }
      return undefined;
    };

    const first = yield* spawn(() => Agent.operations.session("held"));
    yield* arrived.operation;

    // One runtime, one ensure in flight, no handle on it yet.
    expect(harness.createdOptions).toHaveLength(1);

    let refused: Error | undefined;
    try {
      yield* Agent.operations.session("failing");
    } catch (error) {
      refused = error as Error;
    }
    expect(refused?.message).toContain("could not open");

    // The sibling gave up its own claim. The partition is still standing on
    // the work that has not finished, so a third session bound to the same
    // build reaches the same child rather than starting another.
    const third = yield* Agent.operations.session("later");
    expect(third.agentSessionId).toBe(THIRD);
    expect(harness.createdOptions).toHaveLength(1);

    gate.resolve();
    const settled = yield* first;
    expect(settled.agentSessionId).toBe(FIRST);
    expect(harness.createdOptions).toHaveLength(1);
  });

  it("RT6: two operations crossing the same lookup suspension converge on one runtime", function* () {
    // Building a runtime resolves the directory an Agent runs in, and that
    // suspends. Two operations electing the same partition can both be inside
    // it, both having already missed the map — so the decision and the
    // publication have to be one step, with the map read again after the
    // suspension rather than before it.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    const barrier = createCwdBarrier(CWD);
    const alpha = deriveSessionKey(AGENT_COMMAND, CWD, "alpha");
    const beta = deriveSessionKey(AGENT_COMMAND, CWD, "beta");
    yield* routes.publish(route(alpha, FIRST));
    yield* routes.publish(route(beta, SECOND));
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      observer: observer.observer,
      agentCwd: barrier.agentCwd,
    });

    // Each operation asks twice: once to place its session, once while building
    // the runtime that will ensure it. Releasing only the first of each leaves
    // both parked in the second.
    const first = yield* spawn(() => Agent.operations.session("alpha"));
    yield* barrier.waiting(1);
    barrier.release(0);
    yield* barrier.waiting(2);

    const second = yield* spawn(() => Agent.operations.session("beta"));
    yield* barrier.waiting(3);
    barrier.release(2);
    yield* barrier.waiting(4);

    // Both are inside the lookup, and neither has published anything.
    expect(harness.createdOptions).toEqual([]);

    barrier.release(1);
    barrier.release(3);
    const alphaSession = yield* first;
    const betaSession = yield* second;

    expect(alphaSession.agentSessionId).toBe(FIRST);
    expect(betaSession.agentSessionId).toBe(SECOND);
    // One binding, one child. The loser of that race adopts the winner rather
    // than standing up a second one nothing could later evict.
    expect(harness.createdOptions).toHaveLength(1);
    expect(harness.ensureCalls).toHaveLength(2);
  });

  it("RT7: a sibling releasing cannot evict a partition another operation is standing on", function* () {
    // Eviction is about what is standing on a partition, not about who finished
    // last. While one operation holds a claim, a sibling completing and
    // releasing its own handle takes the count to zero for itself and not for
    // the partition.
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    const held = deriveSessionKey(AGENT_COMMAND, CWD, "held");
    const beta = deriveSessionKey(AGENT_COMMAND, CWD, "beta");
    const gamma = deriveSessionKey(AGENT_COMMAND, CWD, "gamma");
    const delta = deriveSessionKey(AGENT_COMMAND, CWD, "delta");
    yield* routes.publish(route(held, FIRST));
    yield* routes.publish(route(beta, SECOND));
    yield* routes.publish(route(gamma, THIRD));
    yield* routes.publish(route(delta, FOURTH));
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: adapter() },
      routeStore: routes,
      observer: observer.observer,
    });

    const gate = withResolvers<void>();
    const arrived = withResolvers<void>();
    harness.ensureGate = (input) => {
      if (input.sessionKey !== held) {
        return undefined;
      }
      arrived.resolve();
      return gate.operation;
    };

    const holding = yield* spawn(() => Agent.operations.session("held"));
    yield* arrived.operation;
    expect(harness.createdOptions).toHaveLength(1);

    // A sibling runs to completion beside it, which releases its own handle on
    // the way out. The partition survives that, because the first operation is
    // still standing on it.
    const betaSession = yield* Agent.operations.session("beta");
    expect(betaSession.agentSessionId).toBe(SECOND);
    expect(harness.createdOptions).toHaveLength(1);

    // And a third reaches the same child rather than starting another.
    const gammaSession = yield* Agent.operations.session("gamma");
    expect(gammaSession.agentSessionId).toBe(THIRD);
    expect(harness.createdOptions).toHaveLength(1);

    // Only once the work that was standing on it finishes — and releases its
    // own handle — is the partition gone, and only then does the next operation
    // observe again and build one of its own.
    gate.resolve();
    const heldSession = yield* holding;
    expect(heldSession.agentSessionId).toBe(FIRST);

    const deltaSession = yield* Agent.operations.session("delta");
    expect(deltaSession.agentSessionId).toBe(FOURTH);
    expect(harness.createdOptions).toHaveLength(2);
  });

  it("RT4: provider teardown settles a partition still holding a handle", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, {
        // Unadvertised: no ownership is taken, so the prompt registers no
        // release and the handle it made is still live when the scope ends.
        advertise: [],
        attach: [],
        adapters: { claude: adapter() },
        routeStore: routes,
      });
      yield* scoped(function* () {
        const stream = yield* Agent.operations.prompt("hello", {});
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });
      expect(harness.closeCalls).toEqual([]);
    });

    expect(harness.closeCalls).toHaveLength(1);
  });
});

/**
 * Tier LU — the released unbound client-native contract
 * (specs/native-agent-session-launch-spec.md §Durability and replay).
 *
 * A session constructed before XMD recorded which build accepted its identity
 * keeps exactly the behavior that released: native resume, under the launcher
 * name, with nothing written into the record it never had. What it may not do
 * is anything that depends on knowing the build.
 */
describe("Tier LU — legacy unbound client-native", () => {
  const ALLOCATED = "55555555-6666-7777-8888-999999999999";

  const ADAPTER: NativeAdapter = {
    launcher: "claude",
    identity: "client-allocated",
    binding: TEST_BINDING,
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

  const KEY = { provider: "acpx", agent: AGENT_COMMAND, sessionKey: SESSION_KEY };

  function legacyRoute(): AgentSessionRoute {
    return {
      schema: "session-route.v1",
      route: "client-native",
      provider: "acpx",
      agent: AGENT_COMMAND,
      sessionKey: SESSION_KEY,
      nativeSessionId: ALLOCATED,
      identityProvenance: "client-allocated",
      instructionsDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      launcher: "claude",
    };
  }

  function legacyRecord(): PreparedLaunchRecord {
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
    };
  }

  it("LU1: a legacy route still resumes natively, under the launcher name", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    const routes = createMemorySessionRouteStore();
    const observer = createFakeObserver();
    yield* routes.publish(legacyRoute());
    yield* installLaunchStack(harness, trace, {
      adapters: { claude: ADAPTER },
      routeStore: routes,
      observer: observer.observer,
    });

    yield* launch(INSTRUCTIONS);

    // Exactly what the released contract does: the launcher name, the retained
    // identity, no build observed, and no binding invented for a session that
    // never recorded one.
    expect(trace.launches[0]!.command).toEqual(["claude", "--resume", ALLOCATED]);
    expect(observer.observed).toEqual([]);
    const prepared = trace.records[0] as PreparedLaunchRecord;
    expect(prepared.executableBinding).toBe(undefined);
    expect(yield* routes.read(KEY)).toEqual(legacyRoute());
  });

  it("LU2: an incomplete legacy replay refuses before any live work", function* () {
    // The predecessor prepared under a contract that recorded no build, so
    // nothing here can show which build has this session's history. Resuming
    // anyway would be answering the question by ignoring it.
    for (const suffix of ["prepared", "prepared+detached"] as const) {
      yield* scoped(function* () {
        const harness = createFakeRuntime();
        const trace = newTrace();
        const routes = createMemorySessionRouteStore();
        const observer = createFakeObserver();
        yield* routes.publish(legacyRoute());
        yield* installLaunchStack(harness, trace, {
          adapters: { claude: ADAPTER },
          routeStore: routes,
          observer: observer.observer,
        });
        trace.replay = { prepared: legacyRecord(), suffix };

        yield* Agent.operations.launch(launchRequest(INSTRUCTIONS));

        const failed = trace.records.findLast((record) => record.failure);
        expect([suffix, failed?.failure?.class]).toEqual([suffix, "executable-binding-refused"]);
        expect([suffix, trace.launches]).toEqual([suffix, []]);
        expect([suffix, harness.ensureCalls]).toEqual([suffix, []]);
        // Nothing was upgraded on the way past.
        expect([suffix, yield* routes.read(KEY)]).toEqual([suffix, legacyRoute()]);
      });
    }
  });
});

/**
 * Tier AO — an ACP-only profile reaches none of the machine-wide account
 * (specs/acp-client-spec.md §ACPX provider).
 *
 * A specialized host may not acquire ordinary-run capabilities by omission. The
 * workflow profile is exactly such a host: its sessions belong to a run, and
 * the coordinator, the construction route and the executable observer describe
 * a different account entirely. Stating both sets empty is what makes that
 * true, and the only way to say it is to hand this provider all three seams and
 * show none of them is touched.
 */
describe("Tier AO — explicit ACP-only capability", () => {
  it("AO1: an ACP-only Claude prompt touches no coordinator, route or observer", function* () {
    const touched: string[] = [];
    const harness = createFakeRuntime();
    const trace = newTrace();

    yield* useFlatWorld(CWD);
    const factory = createAcpxProvider({
      createRuntime: harness.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ claude: AGENT_COMMAND }),
      // The whole point: stated, not inherited.
      advertiseNativeLaunch: [],
      advertiseClientNativeAttachment: [],
      // Poison. Every one of these is available, and reaching any of them is
      // this profile acting on an account it does not own.
      coordinator: {
        *coordinate(_key, _owner, body) {
          touched.push("coordinator");
          return Ok(yield* body({ quiesced() {} }));
        },
      },
      routeStore: {
        // deno-lint-ignore require-yield
        *read(): Operation<AgentSessionRoute | undefined> {
          touched.push("route:read");
          return undefined;
        },
        // deno-lint-ignore require-yield
        *publish(candidate) {
          touched.push("route:publish");
          return candidate;
        },
      },
      executableObserver: {
        // deno-lint-ignore require-yield
        *observe() {
          touched.push("observer");
          throw new Error("this profile observes no build");
        },
      },
    });

    yield* scoped(function* () {
      yield* factory({ defaultAgent: "claude", permissionMode: "deny-all" }, traceAuthority(trace));
      const stream = yield* Agent.operations.prompt("what changed?", {});
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      expect(next.value).toBe("hello world");
    });

    // The turn happened, through the ordinary unbound ACP path.
    expect(harness.turns).toHaveLength(1);
    expect(touched).toEqual([]);
  });
});

/**
 * Tier CV — the shipped Claude adapter's canonical version
 * (specs/native-agent-session-launch-spec.md §Executable binding).
 *
 * The fixtures above carry the same contract, but they are fixtures. This is
 * the parser production runs, and what it decides is which builds a session may
 * be bound to at all.
 */
describe("Tier CV — canonical Claude version", () => {
  function parse(output: string): string | undefined {
    const adapter = nativeAdapterFor("claude");
    if (!adapter || !allocatesIdentity(adapter)) {
      throw new Error("the shipped claude adapter names its own sessions");
    }
    return adapter.binding.version(output);
  }

  it("CV1: one canonical line is the answer, whole", function* () {
    // The whole line, not the number: the same version string from a different
    // product would otherwise compare equal.
    expect(parse("2.1.241 (Claude Code)\n")).toBe("2.1.241 (Claude Code)");
    expect(parse("  2.1.241 (Claude Code)  \n")).toBe("2.1.241 (Claude Code)");
    // Surrounded by output that is not a version at all.
    expect(parse("checking for updates\n2.1.241 (Claude Code)\ndone\n")).toBe(
      "2.1.241 (Claude Code)",
    );
  });

  it("CV2: output naming no build is not an answer", function* () {
    for (const output of [
      "",
      "claude version 2.1.241\n",
      "2.1.241\n",
      "2.1.241 (Claude Code) beta\n",
      "v2.1.241 (Claude Code)\n",
    ]) {
      expect([output, parse(output)]).toEqual([output, undefined]);
    }
  });

  it("CV3: output naming several builds is not an answer either", function* () {
    // Taking the first would be choosing a build out of a list of them, which
    // is exactly the question a binding exists to settle.
    expect(parse("2.1.241 (Claude Code)\n2.1.242 (Claude Code)\n")).toBe(undefined);
    // Including two that agree: a file reporting its version twice is a file
    // this adapter cannot read as one answer.
    expect(parse("2.1.241 (Claude Code)\n2.1.241 (Claude Code)\n")).toBe(undefined);
  });
});

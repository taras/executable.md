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
 * The phase journal here collects records and raises a refusal, which is what
 * `<Session.Launch>` does with the same records; core's own tests own the
 * durability and settlement halves of that.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, until, withResolvers } from "effection";
import { when } from "@effectionx/converge";
import type { Operation } from "effection";
import { Agent, AgentLaunchJournal } from "@executablemd/core";
import type {
  AgentPromptEvent,
  DetachedLaunchRecord,
  ExitedLaunchRecord,
  Session,
  LaunchRecord,
  PreparedLaunchRecord,
} from "@executablemd/core";
import { installControlledLauncher } from "@executablemd/runtime";
import type { NativeLaunchRequest } from "@executablemd/runtime";
import { createAcpxProvider } from "../src/provider.ts";
import { ExecutableBinding, SessionLease } from "@executablemd/runtime";
import type { SessionLeaseOutcome } from "@executablemd/runtime";
import { nativeAdapterFor, pinnedAdapterCommands } from "../src/native-launch.ts";
import type { NativeAdapter } from "../src/native-launch.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import {
  createSessionRouteStore,
  NativeSessionConflict,
  parseSessionRoute,
} from "../src/native-session-store.ts";
import type { ClientNativeRoute, SessionRouteStore } from "../src/native-session-store.ts";
import { SessionBusy } from "../src/session-ownership.ts";
import { createAgentRegistry } from "../src/acpx-runtime.ts";
import { API } from "@executablemd/runtime";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { createFakeRuntime, makeRecord, makeRegistry, makeStore, useFlatWorld } from "./helpers.ts";
import type { FakeRuntimeHarness } from "./helpers.ts";
import type { AcpSessionRecord, AcpSessionStore } from "../src/acpx-runtime.ts";

const CWD = "/work";
const AGENT_COMMAND = "scripted-cmd";

/**
 * The agent this tier launches.
 *
 * Deliberately not Claude. These cases describe the provider-returned
 * sequence — the provider creates the session and reports what it called it —
 * and Claude does the opposite: XMD allocates the identity and binds an
 * executable build to it. Naming Claude here would make every case in this
 * tier depend on whichever Claude the host has installed, and would test a
 * path Claude no longer takes. Tier CB below covers the bound one.
 */
const AGENT = "scripted";

const SCRIPTED_ADAPTER: NativeAdapter = {
  launcher: "scripted-ui",
  identity: "provider-returned",
  resume: (nativeSessionId) => ["scripted-ui", "--resume", nativeSessionId],
};
const SESSION_KEY = deriveSessionKey(AGENT_COMMAND, CWD);

/** Everything the launch touched, in the order it touched it. */
interface Trace {
  records: LaunchRecord[];
  launches: NativeLaunchRequest[];
  /** Provider and launcher events interleaved, so ordering is provable. */
  order: string[];
  failures: Error[];
}

interface ProviderOptions {
  advertise?: readonly string[];
  store?: AcpSessionStore;
  adapters?: Record<string, NativeAdapter>;
  /** Blocks the native child until this resolves. */
  hold?: Operation<void>;
  onLaunch?: () => void;
  exitCode?: number;
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

  // What `<Session.Launch>` does with each phase, minus the journal: keep the
  // record, and stop the provider where a retained refusal says it stopped.
  yield* AgentLaunchJournal.around(
    {
      *recordPreparation([live]) {
        const record = yield* live();
        trace.records.push(record);
        trace.order.push("prepared");
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
      *recordDetach([live]) {
        const record = yield* live();
        trace.records.push(record);
        trace.order.push("detached");
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
      *recordExit([live]) {
        const record = yield* live();
        trace.records.push(record);
        trace.order.push("exited");
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
    },
    { at: "min" },
  );

  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: options.store ?? makeStore(),
    agentRegistry: makeRegistry({ [AGENT]: AGENT_COMMAND, mystery: "mystery-cmd" }),
    advertiseNativeLaunch: options.advertise ?? [AGENT],
    nativeAdapters: options.adapters ?? { [AGENT]: SCRIPTED_ADAPTER },
  });
  yield* factory({ defaultAgent: AGENT, permissionMode: "approve-reads" });
}

function newTrace(): Trace {
  return { records: [], launches: [], order: [], failures: [] };
}

/** Run a launch and keep whatever it threw, so a refusal is inspectable. */
function* attempt(
  instructions: string,
  options?: { agent?: string; session?: string | Session },
): Operation<Error | undefined> {
  try {
    yield* Agent.operations.launch(instructions, options);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const INSTRUCTIONS = "You are the repository implementor.";

describe("Tier NL — native session launch", () => {
  it("NL1: an agent with no advertised native launcher is refused before a session exists", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { advertise: [] });
      const failure = yield* attempt(INSTRUCTIONS);

      expect(failure?.message).toContain("not advertised as native-launch capable");
      // Refused with ACP still owning nothing at all: no session was created,
      // none was released, and no child started.
      expect(harness.ensureCalls.length).toBe(0);
      expect(harness.closeCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
      expect(trace.records[0]?.failure?.class).toBe("unsupported-capability");
    });
  });

  it("NL2: an agent this package has no command shape for is refused", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { advertise: ["mystery"] });
      const failure = yield* attempt(INSTRUCTIONS, { agent: "mystery" });

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
      const failure = yield* attempt(INSTRUCTIONS);

      expect(failure?.message).toContain("asserted no provider-native session identity");
      expect(trace.records[0]?.failure?.class).toBe("identity-unavailable");
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
      yield* Agent.operations.launch(INSTRUCTIONS);

      expect(harness.ensureCalls.length).toBe(1);
      expect(harness.ensureCalls[0]).toMatchObject({
        sessionKey: SESSION_KEY,
        agent: AGENT,
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
      yield* Agent.operations.launch(INSTRUCTIONS);

      expect(trace.order).toEqual(["prepared", "detached", "spawn", "exited"]);
      expect(harness.closeCalls.length).toBe(1);
      expect(harness.closeCalls[0]?.sessionKey).toBe(SESSION_KEY);
      // Released, not discarded. This is the one close a launch performs, and
      // the record behind it is what the native UI is about to resume.
      expect(harness.closeRequests[0]?.discardPersistentState).toBeUndefined();
    });
  });

  it("NL6: only the provider-asserted native identity crosses the handoff", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      const result = yield* Agent.operations.launch(INSTRUCTIONS);

      const nativeSessionId = `agent-session:${SESSION_KEY}`;
      expect(result.nativeSessionId).toBe(nativeSessionId);
      expect(result.launcher).toBe(SCRIPTED_ADAPTER.launcher);
      expect(trace.launches[0]?.command).toEqual(["scripted-ui", "--resume", nativeSessionId]);
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
      yield* Agent.operations.launch(`${INSTRUCTIONS}\n${sentinel}\n`);

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
      yield* Agent.operations.launch(INSTRUCTIONS);

      const prepared = trace.records[0];
      expect(prepared).toMatchObject({
        phase: "prepared",
        agent: AGENT,
        sessionKey: SESSION_KEY,
        provider: "acpx",
        sessionState: "created",
        instructionChannel: "acp.session.systemPrompt",
        instructions: INSTRUCTIONS,
        cwd: CWD,
        additionalDirectories: [],
        permissionMode: "approve-reads",
        launcher: SCRIPTED_ADAPTER.launcher,
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
      const failure = yield* attempt(INSTRUCTIONS);

      expect(failure?.message).toContain("already carries a different XMD instruction layer");
      expect(trace.records[0]?.failure?.class).toBe("instructions-refused");
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
      yield* Agent.operations.launch(INSTRUCTIONS);

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

      yield* Agent.operations.launch(INSTRUCTIONS);
      // The handle the launch released is the last one this provider held.
      expect(harness.closeCalls.at(-1)?.sessionKey).toBe(SESSION_KEY);
      const ensuresAfterLaunch = harness.ensureCalls.length;

      // The session is still reachable by name, and reaching it re-ensures:
      // the handle this provider held predates the native handoff, so a turn
      // started on it would be a turn on a connection older than the UI's.
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

  it("NL12: a prompt for the launched session waits for the native child to exit", function* () {
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

      const launching = yield* spawn(() => Agent.operations.launch(INSTRUCTIONS));
      yield* started.operation;

      const prompting = yield* spawn(function* () {
        return yield* scoped(function* () {
          const stream = yield* Agent.operations.prompt("meanwhile", {});
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
          trace.order.push("prompted");
        });
      });

      // The native child owns the session, so nothing has run a turn against
      // it — the queued prompt has not even started one.
      expect(harness.turns.length).toBe(0);

      hold.resolve();
      yield* launching;
      yield* prompting;

      expect(trace.order).toEqual(["prepared", "detached", "spawn", "exited", "prompted"]);
      expect(harness.turns.length).toBe(1);
    });
  });

  it("NL13: a nonzero native exit is the launch's outcome, and the session facts stand", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace, { exitCode: 7 });
      yield* Agent.operations.launch(INSTRUCTIONS);

      // The provider reports what happened; deciding that a nonzero status
      // fails the document belongs to <Session.Launch>.
      expect(trace.records.at(-1)).toMatchObject({ phase: "exited", exitCode: 7 });
      const prepared = trace.records[0];
      expect(prepared).toMatchObject({ nativeSessionId: `agent-session:${SESSION_KEY}` });
    });
  });

  it("NL15: an established session keeps its layer, and a different one is refused", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      // What `<Session name>` does before the `<Session.Launch>` inside it:
      // establishes the session, with no instruction layer and no turns.
      const session = yield* Agent.operations.session();
      expect(harness.ensureCalls.length).toBe(1);

      const failure = yield* attempt(INSTRUCTIONS, { session });

      // V1 discards no persistent ACPX state, so the session cannot be remade
      // carrying the prepared layer. Its transcript is empty whether or not it
      // was ever used — native turns are never mirrored back into it — so
      // there is no evidence under which deleting it would be safe.
      expect(failure?.message).toContain("does not replace one");
      expect(trace.records.at(-1)?.failure?.class).toBe("instructions-refused");
      expect(harness.closeCalls.length).toBe(0);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NL16: a session a native UI already owned is never discarded to change its layer", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      yield* Agent.operations.launch(INSTRUCTIONS);
      expect(trace.launches.length).toBe(1);

      const closesBefore = harness.closeCalls.length;
      // The native UI has been used for an hour. ACPX never sees those turns,
      // so its cached `messages` is still empty — which is exactly the
      // evidence that must not authorize a discard.
      const cached = yield* until(harness.createdOptions[0]!.sessionStore.load(SESSION_KEY));
      expect(cached?.messages ?? []).toEqual([]);

      const failure = yield* attempt("A completely different role.", { agent: AGENT });

      expect(failure?.message).toContain("does not replace one");
      expect(trace.records.at(-1)?.failure?.class).toBe("instructions-refused");
      // Nothing was discarded, nothing detached, nothing spawned.
      expect(harness.closeCalls.length).toBe(closesBefore);
      expect(
        harness.closeRequests.filter((request) => request.discardPersistentState === true),
      ).toEqual([]);
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

      const failure = yield* attempt(INSTRUCTIONS, { agent: AGENT });

      expect(failure?.message).toContain("does not replace one");
      expect(
        harness.closeRequests.filter((request) => request.discardPersistentState === true),
      ).toEqual([]);
      expect(trace.launches.length).toBe(0);
    });
  });

  it("NL18: the record says what was done about the instruction layer", function* () {
    const harness = createFakeRuntime();
    const trace = newTrace();
    yield* scoped(function* () {
      yield* installLaunchStack(harness, trace);
      // A fresh session: the layer is installed with it.
      yield* Agent.operations.launch(INSTRUCTIONS);
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
      yield* Agent.operations.launch(INSTRUCTIONS);
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
 * Tier CB — a session bound to one executable build
 * (specs/native-agent-session-launch-spec.md §Durable binding).
 *
 * Claude's path is the opposite of the tier above: XMD allocates the identity
 * before Claude exists, Claude creates the conversation natively, and ACP only
 * ever reattaches. That only holds together while the build that created the
 * session can be recognized later, so these cases are mostly about what
 * happens when it cannot.
 *
 * The executable here is a real file — written, made executable, and asked for
 * its version — because every property under test is a property of a file:
 * what the digest is, what changes it, and what a second build looks like. The
 * host's own Claude is never touched.
 */
const CLAUDE_VERSION = "2.1.235 (Claude Code)";

interface Bound {
  /** Where the fake claude lives, so a test can change the build. */
  executable: string;
  /** The mapping store's directory, so a test can count identities. */
  store: string;
  trace: Trace;
  harness: FakeRuntimeHarness;
  /** How many times an executable was observed, for the replay contract. */
  observations: () => number;
  /** Every session key exclusive ownership was asked for, in order. */
  leases: string[];
}

/**
 * Records the journal already holds, returned without running the work.
 *
 * That is what replay is: the journal answers from what it retained and the
 * provider's live callback never runs. Modelling it here rather than driving a
 * real durable stream keeps the question to the provider's own ordering, which
 * is what the contract is about.
 */
interface Retained {
  prepared?: PreparedLaunchRecord;
  detached?: DetachedLaunchRecord;
  exited?: ExitedLaunchRecord;
}

function* writeClaude(at: string, version: string, marker: string): Operation<void> {
  yield* until(mkdir(nodePath.dirname(at), { recursive: true }));
  yield* until(writeFile(at, `#!/bin/sh\n# ${marker}\necho "${version}"\n`));
  yield* until(chmod(at, 0o755));
}

/** A provider whose Claude is a fake executable and whose mappings are ours. */
function* installBoundStack(
  options: {
    advertise?: readonly string[];
    version?: string;
    marker?: string;
    /** Blocks the native child until this settles. */
    hold?: Operation<void>;
    /** How the native child exits. Absent means cleanly. */
    exitCode?: number;
    /** Phases the journal already holds, so the live work never runs. */
    retained?: Retained;
    /** Leave the agent registry out, so the provider builds its own. */
    ownRegistry?: boolean;
    /** An existing mapping directory, so a replay reads what an attempt left. */
    store?: string;
    /** An existing ACPX session store, so a fresh scope reopens its records. */
    sessionStore?: AcpSessionStore;
    /**
     * What asking for exclusive live ownership answers.
     *
     * Defaults to a host that can grant it. `busy` is another owner holding
     * the session right now; `unavailable` is a host — Node or Bun — that
     * installs no advisory lock at all.
     */
    lease?: SessionLeaseOutcome | "inherit";
    /**
     * A route store of the caller's own — a wrapper that can hold one
     * publication at a barrier, so a race has a decided winner.
     */
    routeStore?: SessionRouteStore;
  } = {},
): Operation<Bound> {
  const root = yield* useTempDirectory("xmd-cb-");
  const bin = nodePath.join(root, "bin");
  const executable = nodePath.join(bin, "claude");
  yield* writeClaude(executable, options.version ?? CLAUDE_VERSION, options.marker ?? "build-a");
  // The canonical path, because that is what an observation reports: a
  // temporary root on macOS sits under a symlinked `/var`.
  const canonical = yield* until(realpath(executable));

  const harness = createFakeRuntime();
  const trace = newTrace();
  const store = options.store ?? nodePath.join(root, "mappings");

  yield* useFlatWorld(CWD);
  yield* API.Env.around({
    *env([name], next) {
      return name === "PATH" ? bin : yield* next(name);
    },
  });
  yield* installControlledLauncher({
    record: (request) => {
      trace.launches.push(request);
      trace.order.push("spawn");
    },
    ...(options.hold ? { wait: () => options.hold! } : {}),
    outcome: () => ({ exitCode: options.exitCode ?? 0 }),
  });
  const held = options.retained ?? {};
  yield* AgentLaunchJournal.around(
    {
      *recordPreparation([live]) {
        const record = held.prepared ?? (yield* live());
        trace.records.push(record);
        trace.order.push("prepared");
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
      *recordDetach([live]) {
        const record = held.detached ?? (yield* live());
        trace.records.push(record);
        trace.order.push("detached");
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
      *recordExit([live]) {
        const record = held.exited ?? (yield* live());
        trace.records.push(record);
        trace.order.push("exited");
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
    },
    { at: "min" },
  );

  // The contextual lease, injected rather than taken for real: what these
  // cases are about is what the provider does with each answer. `inherit`
  // leaves an outer installation in place, which is how two provider scopes
  // contend for one session the way two processes do.
  const leases: string[] = [];
  const answer = options.lease ?? "acquired";
  if (answer !== "inherit") {
    yield* SessionLease.around({
      // deno-lint-ignore require-yield
      *acquire([key]) {
        leases.push(key);
        return answer;
      },
    });
  }

  // Counted through the same seam production resolves an executable by, so a
  // launch that observes one cannot avoid being seen doing it.
  let observations = 0;
  yield* ExecutableBinding.around({
    *observe([command], next) {
      observations += 1;
      return yield* next(command);
    },
  });

  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: options.sessionStore ?? makeStore(),
    ...(options.ownRegistry ? {} : { agentRegistry: makeRegistry({ claude: AGENT_COMMAND }) }),
    advertiseNativeLaunch: options.advertise ?? ["claude"],
    nativeSessionStore: options.routeStore ?? createSessionRouteStore(store),
  });
  yield* factory({ defaultAgent: "claude", permissionMode: "approve-reads" });

  return {
    executable: canonical,
    store,
    trace,
    harness,
    observations: () => observations,
    leases,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Which construction each route retained beneath `root` claims.
 *
 * Read off the files rather than through the store, so what is asserted is
 * what a second process would find — including how many records exist, which
 * is what says whether a second identity was ever published.
 */
function* retainedRoutes(root: string): Operation<string[]> {
  const entries = yield* until(readdir(root).catch(() => [] as string[]));
  const claims: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const text = yield* until(readFile(nodePath.join(root, entry), "utf8"));
    const parsed = parseSessionRoute(JSON.parse(text));
    claims.push(parsed?.route ?? "unreadable");
  }
  return claims;
}

describe("Tier CB — a session bound to one executable build", () => {
  it("CB1: XMD allocates the identity and Claude creates the session under it", function* () {
    const bound = yield* installBoundStack();

    const result = yield* Agent.operations.launch(INSTRUCTIONS);

    expect(result.nativeSessionId).toMatch(UUID);
    // The identity was supplied to Claude, not read back from it. Nothing ACP
    // or ACPX produced could have become this value: no session was created
    // through ACP at all.
    expect(bound.harness.ensureCalls.length).toBe(0);
    const argv = bound.trace.launches[0]?.command ?? [];
    expect(argv[0]).toBe(bound.executable);
    expect(argv.slice(1, 3)).toEqual(["--session-id", result.nativeSessionId]);
    expect(argv[3]).toBe("--system-prompt-file");
  });

  it("CB2: the retained record carries the build and no path", function* () {
    const bound = yield* installBoundStack();

    yield* Agent.operations.launch(INSTRUCTIONS);

    const prepared = bound.trace.records[0];
    expect(prepared).toMatchObject({
      phase: "prepared",
      identityProvenance: "client-allocated",
      sessionState: "created",
      instructionReconciliation: "installed",
      launcher: "claude",
    });
    const binding = prepared?.phase === "prepared" ? prepared.executableBinding : undefined;
    expect(binding?.schema).toBe("executable-build.v1");
    expect(binding?.reportedVersion).toBe(CLAUDE_VERSION);
    expect(binding?.executableDigest.value).toMatch(/^[0-9a-f]{64}$/);
    // A record naming where a build lived would stop being true the moment it
    // moved, and would describe this host to anyone who read it.
    expect(JSON.stringify(prepared)).not.toContain(bound.executable);
  });

  it("CB3: the prepared instructions travel by private file, and it does not outlive the launch", function* () {
    let instructionFile = "";
    const hold = withResolvers<void>();
    const started = withResolvers<void>();
    yield* scoped(function* () {
      const bound = yield* installBoundStack({
        hold: (function* () {
          started.resolve();
          yield* hold.operation;
        })(),
      });

      const launching = yield* spawn(() => Agent.operations.launch(INSTRUCTIONS));
      yield* started.operation;

      // Observed while the native child is running, which is the only window
      // in which the file is supposed to exist at all.
      const argv = bound.trace.launches[0]?.command ?? [];
      instructionFile = argv[4] ?? "";
      expect(yield* until(readFile(instructionFile, "utf8"))).toBe(INSTRUCTIONS);
      expect((yield* until(stat(instructionFile))).mode & 0o777).toBe(0o600);
      expect((yield* until(stat(nodePath.dirname(instructionFile)))).mode & 0o777).toBe(0o700);
      // Never on a surface another process can read: both would expose the
      // authored instructions to anything that can list processes.
      expect(argv.join("\0")).not.toContain(INSTRUCTIONS);
      expect(JSON.stringify(bound.trace.launches[0]?.env ?? {})).not.toContain(INSTRUCTIONS);

      hold.resolve();
      yield* launching;
    });

    // And gone once the launch is over, without waiting for the process to end.
    expect(
      yield* until(
        stat(instructionFile).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
  });

  it("CB4: relaunching the same session resumes the identity it already has", function* () {
    const bound = yield* installBoundStack();
    const first = yield* Agent.operations.launch(INSTRUCTIONS);

    const second = yield* Agent.operations.launch(INSTRUCTIONS);

    expect(second.nativeSessionId).toBe(first.nativeSessionId);
    const argv = bound.trace.launches[1]?.command ?? [];
    // Resume, not create: the conversation already exists, and asking Claude to
    // create it again under the same name is not a second chance.
    expect(argv.slice(1)).toEqual(["--resume", first.nativeSessionId]);
    const files = yield* until(readdir(bound.store));
    expect(files.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });

  it("CB5: a different build refuses before detach or spawn", function* () {
    const bound = yield* installBoundStack();
    yield* Agent.operations.launch(INSTRUCTIONS);
    const before = bound.trace.launches.length;
    const closes = bound.harness.closeCalls.length;

    // Same version, same path, different bytes — the case nothing else can see,
    // and the one that otherwise produces an empty conversation.
    yield* writeClaude(bound.executable, CLAUDE_VERSION, "build-b");
    const failure = yield* attempt(INSTRUCTIONS);

    expect(failure?.message).toContain("different build");
    expect(bound.trace.records.at(-1)?.failure?.class).toBe("executable-binding-refused");
    expect(bound.trace.launches.length).toBe(before);
    expect(bound.harness.closeCalls.length).toBe(closes);
  });

  it("CB6: a changed version refuses, and says which is expected", function* () {
    const bound = yield* installBoundStack();
    yield* Agent.operations.launch(INSTRUCTIONS);

    yield* writeClaude(bound.executable, "2.1.232 (Claude Code)", "build-a");
    const failure = yield* attempt(INSTRUCTIONS);

    expect(failure?.message).toContain("different");
    const refused = bound.trace.records.at(-1);
    expect(refused?.failure?.class).toBe("executable-binding-refused");
    // Diagnostics an author can act on, and nothing else: no path, no argv, no
    // environment, no raw command output.
    expect(refused?.failure?.message).not.toContain(bound.executable);
    expect(refused?.failure?.message).not.toContain("/");
  });

  it("CB7: an unrecognized version is refused rather than retained under a guess", function* () {
    const bound = yield* installBoundStack({ version: "not a version" });

    const failure = yield* attempt(INSTRUCTIONS);

    expect(failure?.message).toContain("did not report a version");
    expect(bound.trace.records[0]?.failure?.class).toBe("executable-binding-refused");
    expect(bound.trace.launches.length).toBe(0);
    const files = yield* until(readdir(bound.store).catch(() => [] as string[]));
    // Nothing was allocated: an identity published here could never be
    // confirmed against anything.
    expect(files.filter((entry) => entry.endsWith(".json"))).toHaveLength(0);
  });

  it("CB8: a later prompt reattaches to the allocated identity on the bound runtime", function* () {
    const bound = yield* installBoundStack();
    const launched = yield* Agent.operations.launch(INSTRUCTIONS);

    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt("continue");
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });

    // The identity XMD allocated, handed back unchanged.
    expect(bound.harness.ensureCalls.at(-1)?.resumeSessionId).toBe(launched.nativeSessionId);
    // And through a runtime whose children run the build that created it.
    const options = bound.harness.createdOptions.at(-1);
    expect(options?.agentProcessEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: bound.executable });
  });

  it("CB9: the bound executable never reaches a session record or this process", function* () {
    const bound = yield* installBoundStack();
    yield* Agent.operations.launch(INSTRUCTIONS);

    // Transient by construction: it is an input to the children a runtime
    // spawns, and belongs nowhere that outlives them.
    for (const input of bound.harness.ensureCalls) {
      expect(JSON.stringify(input.sessionOptions ?? {})).not.toContain(bound.executable);
    }
    expect(process.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  });

  it("CB10: a changed instruction layer is refused, whatever the ACPX cache says", function* () {
    const bound = yield* installBoundStack();
    yield* Agent.operations.launch(INSTRUCTIONS);

    const failure = yield* attempt("A completely different role.");

    // Native turns are never mirrored back, so an empty cache is not evidence
    // that the conversation is empty — and discarding it on that basis would
    // destroy history XMD cannot see.
    expect(failure?.message).toContain("different XMD instruction layer");
    expect(bound.trace.records.at(-1)?.failure?.class).toBe("instructions-refused");
  });

  it("CB12: a later prompt refuses a changed build before it creates or starts anything", function* () {
    const bound = yield* installBoundStack();
    yield* Agent.operations.launch(INSTRUCTIONS);
    const ensured = bound.harness.ensureCalls.length;

    yield* writeClaude(bound.executable, "2.1.232 (Claude Code)", "build-a");
    let refused: Error | undefined;
    yield* scoped(function* () {
      try {
        const stream = yield* Agent.operations.prompt("continue");
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }
    });

    // The whole point of refusing here: an unbound reattachment would have
    // succeeded, reported a healthy session, completed the turn, and answered
    // out of a conversation that no longer had any history in it.
    expect(refused?.message).toContain("different");
    expect(bound.harness.ensureCalls.length).toBe(ensured);
    expect(bound.harness.turns.length).toBe(0);
  });

  it("CB13: Claude runs the pinned ACP adapter, not whatever ACPX's range selects", function* () {
    // ACPX resolves Claude through its own `^0.37.0` range. The behavior
    // #519's gates measured — whether a resume identity reaches the SDK — is
    // adapter behavior, so a range free to select a different adapter would
    // make the proof describe a version nobody runs.
    const pinned = pinnedAdapterCommands();
    expect(pinned.claude).toBe("npx -y @agentclientprotocol/claude-agent-acp@0.70.0");
    // Nothing is pinned for an agent whose identity the provider returns.
    expect(Object.hasOwn(pinned, "codex")).toBe(false);

    // The override is load-bearing: without it ACPX resolves something else.
    expect(createAgentRegistry().resolve("claude")).not.toBe(pinned.claude);
    expect(createAgentRegistry({ overrides: pinned }).resolve("claude")).toBe(pinned.claude);

    // And the provider that builds its own registry uses it — observed on the
    // registry it actually hands the runtime, not on the table it read.
    const bound = yield* installBoundStack({ ownRegistry: true });
    yield* Agent.operations.launch(INSTRUCTIONS);
    const handed = bound.harness.createdOptions.at(0)?.agentRegistry;
    expect(handed?.resolve("claude")).toBe(pinned.claude);
  });

  it("CB14: a completed replay observes no executable and starts no provider", function* () {
    // Everything a launch does that touches the world sits behind the journal.
    // A completed launch retains all three phases, so the journal answers from
    // what it holds and nothing runs — but resolving the agent happens
    // *before* the journal, and an executable observed there would be observed
    // on every replay of a launch that performs nothing.
    const bound = yield* installBoundStack({
      retained: {
        prepared: {
          phase: "prepared",
          agent: "claude",
          sessionKey: deriveSessionKey(AGENT_COMMAND, CWD),
          provider: "acp",
          nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
          sessionState: "created",
          instructionChannel: "acp.session.systemPrompt",
          instructionReconciliation: "installed",
          instructionsDigest: "e".repeat(64),
          instructions: INSTRUCTIONS,
          cwd: CWD,
          additionalDirectories: [],
          permissionMode: "approve-reads",
          launcher: "claude",
          identityProvenance: "client-allocated",
          executableBinding: {
            schema: "executable-build.v1",
            reportedVersion: CLAUDE_VERSION,
            executableDigest: { algorithm: "sha256", value: "f".repeat(64) },
          },
        },
        detached: { phase: "detached" },
        exited: { phase: "exited", exitCode: 0 },
      },
    });

    const result = yield* Agent.operations.launch(INSTRUCTIONS);

    expect(result.nativeSessionId).toBe("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    // The retained binding names a build that is not the one installed here,
    // so any observation would also have refused — and the launch succeeded,
    // which is only possible because none was made.
    expect(bound.observations()).toBe(0);
    expect(bound.harness.createdOptions.length).toBe(0);
    expect(bound.trace.launches.length).toBe(0);
  });

  it("CB15: a mapping that describes another session is refused, not returned", function* () {
    const root = yield* useTempDirectory("xmd-cb-");
    const store = createSessionRouteStore(root);
    const mapping: ClientNativeRoute = {
      schema: "session-route.v1",
      route: "client-native",
      provider: "acp",
      agent: "claude",
      sessionKey: "session:main",
      nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      identityProvenance: "client-allocated",
      instructionsDigest: "a".repeat(64),
      launcher: "claude",
      executableBinding: {
        schema: "executable-build.v1",
        reportedVersion: CLAUDE_VERSION,
        executableDigest: { algorithm: "sha256", value: "b".repeat(64) },
      },
    };
    yield* store.publish(mapping);

    // The file is named by a digest of the key it was created under, so its
    // contents naming a different session means it was moved, hand-edited or
    // written by another scheme. It stays well-formed and it stays where the
    // lookup expects it, which is exactly why only a key check catches it.
    const [file] = yield* until(readdir(root));
    yield* until(
      writeFile(
        nodePath.join(root, file!),
        JSON.stringify({ ...mapping, sessionKey: "session:someone-else" }, null, 2),
      ),
    );

    let refused: unknown;
    try {
      yield* store.read(mapping);
    } catch (error) {
      refused = error;
    }

    // Returning it would hand this session another one's identity, which is
    // the substitution the whole arrangement exists to prevent.
    expect(refused).toBeInstanceOf(NativeSessionConflict);
  });

  it("CB16: an incomplete replay whose mapping disagrees refuses before detach or spawn", function* () {
    const bound = yield* installBoundStack();
    const first = yield* Agent.operations.launch(INSTRUCTIONS);
    const closes = bound.harness.closeCalls.length;
    const spawns = bound.trace.launches.length;

    // The two durable accounts of one launch, disagreeing. Each is internally
    // valid; only comparing them shows that one of them is describing a
    // different conversation.
    const [file] = yield* until(readdir(bound.store));
    const retainedMapping = JSON.parse(
      yield* until(readFile(nodePath.join(bound.store, file!), "utf8")),
    );
    yield* until(
      writeFile(
        nodePath.join(bound.store, file!),
        JSON.stringify(
          { ...retainedMapping, nativeSessionId: "ffffffff-0000-4000-8000-000000000000" },
          null,
          2,
        ),
      ),
    );

    const prepared = bound.trace.records.find((record) => record.phase === "prepared");
    const replayed = yield* installBoundStack({
      // The same mapping directory the first attempt wrote to: a replay that
      // read a different store would be refused for having no mapping at all,
      // which is a different contract.
      store: bound.store,
      retained: { prepared: prepared as PreparedLaunchRecord },
    });
    let refused: Error | undefined;
    try {
      yield* Agent.operations.launch(INSTRUCTIONS);
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }

    expect(first.nativeSessionId).not.toBe("ffffffff-0000-4000-8000-000000000000");
    expect(refused?.message).toContain("different sessions");
    expect(replayed.trace.launches.length).toBe(0);

    // The same refusal for a mapping that agrees on everything it retained but
    // names another provider. An identity only means something under the
    // provider that allocated it, so agreement has to include who that was.
    yield* until(
      writeFile(
        nodePath.join(bound.store, file!),
        JSON.stringify({ ...retainedMapping, provider: "someone-else" }, null, 2),
      ),
    );
    const foreign = yield* installBoundStack({
      store: bound.store,
      retained: { prepared: prepared as PreparedLaunchRecord },
    });
    let refusedForeign: Error | undefined;
    try {
      yield* Agent.operations.launch(INSTRUCTIONS);
    } catch (error) {
      refusedForeign = error instanceof Error ? error : new Error(String(error));
    }
    expect(refusedForeign).toBeDefined();
    expect(foreign.trace.launches.length).toBe(0);
    // Refused while ACP still owns the session and before anything was
    // started, which is the only point at which refusing costs nothing.
    expect(bound.harness.closeCalls.length).toBe(closes);
    expect(bound.trace.launches.length).toBe(spawns);
    expect(replayed.trace.launches.length).toBe(0);
  });

  it("CB17: ordinary agent resolution still asks whether the bound build is available", function* () {
    // Deferring the probe is only correct for the launch path. Asking whether
    // an agent is available is its own question, and for a bound agent the
    // only useful answer is the one its build gives — so this must observe,
    // and it must probe the bound runtime rather than an unbound one.
    const bound = yield* installBoundStack();

    const resolved = yield* Agent.operations.agent("claude");

    expect(resolved).toBe("claude");
    expect(bound.observations()).toBeGreaterThan(0);
    const probed = bound.harness.createdOptions.at(-1);
    expect(probed?.agentProcessEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: bound.executable });
    expect(bound.harness.doctorCalls).toBeGreaterThan(0);
  });

  it("CB18: an eager ACP session claims the route, and a client-native launch refuses", function* () {
    // `<Session name>` establishes a session before its body runs, which is
    // ACP choosing construction. A client-allocated launch cannot take that
    // back: the conversation ACP established is the one that exists under this
    // name, and a route never converts.
    const bound = yield* installBoundStack();
    yield* Agent.operations.session("implementor");
    expect(bound.harness.ensureCalls.length).toBeGreaterThan(0);

    const failure = yield* attempt(INSTRUCTIONS, { session: "implementor" });

    expect(failure?.message).toContain("cannot take over a session it did not create");
    expect(bound.trace.records.at(-1)?.failure?.class).toBe("identity-unavailable");
    // Refused before ownership was even asked for, before anything detached,
    // and before a child — so nothing had to be undone.
    expect(bound.trace.order).toEqual(["prepared"]);
    expect(bound.leases).toEqual([]);
    expect(bound.harness.closeRequests).toEqual([]);
    expect(bound.trace.launches.length).toBe(0);
    // One record, and it is the ACP-first claim: no identity was allocated.
    expect(yield* retainedRoutes(bound.store)).toEqual(["acp-first"]);
  });

  it("CB18b: no launch path discards persistent state, whatever it was handed", function* () {
    // The invariant stated once, over every shape the tier drives: a fresh
    // launch, a relaunch of the same layer, and a launch refused because ACP
    // already owns the session. None of them may remove an ACPX record,
    // because none of them can prove the record is theirs to remove.
    const closes: { discardPersistentState?: boolean }[] = [];
    // Separate scopes, because a second provider installed beside the first
    // would leave whichever one lost the contextual seams unexercised — and an
    // unexercised harness reports no closes for the wrong reason.
    yield* scoped(function* () {
      const fresh = yield* installBoundStack();
      yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      expect(fresh.trace.launches.length).toBe(2);
      closes.push(...fresh.harness.closeRequests);
    });

    yield* scoped(function* () {
      const claimed = yield* installBoundStack();
      yield* Agent.operations.session("reviewer");
      const failure = yield* attempt(INSTRUCTIONS, { session: "reviewer" });
      expect(failure?.message).toContain("cannot take over a session it did not create");
      closes.push(...claimed.harness.closeRequests);
    });

    // Not merely "no discard": a client-native launch closes nothing at all,
    // because it never established the ACP session it would be closing. NL5
    // covers the one close a provider-returned launch does perform, and that
    // one carries no discard either.
    expect(closes).toEqual([]);
  });

  it("CB20: a retained detach resumes the retained identity and never retries creation", function* () {
    const routes = yield* useTempDirectory("xmd-cb-");
    let prepared: PreparedLaunchRecord | undefined;
    yield* scoped(function* () {
      const first = yield* installBoundStack({ store: routes });
      yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      const record = first.trace.records.find((entry) => entry.phase === "prepared");
      prepared = record as PreparedLaunchRecord;
    });

    // The attempt that already moved ownership left `detached` behind. What
    // follows must resume the conversation the native side created, not
    // create the session again and not discard anything on the way.
    const replayed = yield* installBoundStack({
      store: routes,
      retained: { prepared: prepared!, detached: { phase: "detached" } },
    });
    yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });

    expect(replayed.harness.closeRequests).toEqual([]);
    expect(replayed.trace.launches[0]?.command.slice(1)).toEqual([
      "--resume",
      prepared!.nativeSessionId,
    ]);
    // The incomplete replay took live ownership before it reconciled, and the
    // route it reconciled against is the one the first attempt published.
    expect(replayed.leases).toHaveLength(1);
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  });

  it("CB21: a refusal before the prepared commit retains nothing and frees ownership", function* () {
    // Once an identity is published it can never be replaced, so a launch that
    // cannot confirm its build has to stop while stopping still costs nothing.
    // Live ownership goes back too: a refused attempt that kept the lease
    // would lock the user out of a session it never created.
    const bound = yield* installBoundStack();
    yield* writeClaude(bound.executable, "not a version", "build-a");

    const failure = yield* attempt(INSTRUCTIONS, { session: "implementor" });

    expect(failure?.message).toContain("did not report a version");
    expect(bound.trace.records.at(-1)?.failure?.class).toBe("executable-binding-refused");
    expect(bound.trace.order).toEqual(["prepared"]);
    expect(bound.harness.closeRequests).toEqual([]);
    expect(yield* retainedRoutes(bound.store)).toEqual([]);

    // The proof that ownership was released rather than held: the same session
    // launches once the build is readable again.
    yield* writeClaude(bound.executable, CLAUDE_VERSION, "build-a");
    const result = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });

    expect(result.nativeSessionId).toMatch(UUID);
    expect(yield* retainedRoutes(bound.store)).toEqual(["client-native"]);
  });

  it("CB22: ordinary resolution fails when the bound executable cannot be validated", function* () {
    // Deferral belongs to the launch path alone. Everywhere else, "I could not
    // check" is not an answer — reporting the agent as available on the
    // strength of having failed to validate it is how an unusable Claude
    // reaches a session instead of being refused at the first Agent use.
    const missing = yield* installBoundStack({ version: "not a version" });

    let refusedName: Error | undefined;
    try {
      yield* Agent.operations.agent("claude");
    } catch (error) {
      refusedName = error instanceof Error ? error : new Error(String(error));
    }

    let refusedSession: Error | undefined;
    try {
      yield* Agent.operations.session("implementor");
    } catch (error) {
      refusedSession = error instanceof Error ? error : new Error(String(error));
    }

    expect(refusedName?.message).toContain("did not report a version");
    expect(refusedSession?.message).toContain("did not report a version");
    // Nothing was established on the strength of an unchecked agent.
    expect(missing.harness.ensureCalls.length).toBe(0);
  });

  it("CB22b: an absent bound executable fails ordinary resolution too", function* () {
    const root = yield* useTempDirectory("xmd-cb-");
    const harness = createFakeRuntime();
    yield* useFlatWorld(CWD);
    yield* API.Env.around({
      *env([name], next) {
        // A search path with no claude on it at all, which is a different
        // failure from one whose version cannot be read.
        return name === "PATH" ? nodePath.join(root, "empty") : yield* next(name);
      },
    });
    const factory = createAcpxProvider({
      createRuntime: harness.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ claude: AGENT_COMMAND }),
      advertiseNativeLaunch: ["claude"],
      nativeSessionStore: createSessionRouteStore(nodePath.join(root, "mappings")),
    });
    yield* factory({ defaultAgent: "claude", permissionMode: "approve-reads" });

    let refused: Error | undefined;
    try {
      yield* Agent.operations.agent("claude");
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }

    expect(refused?.message).toContain("could not be used");
    expect(harness.ensureCalls.length).toBe(0);
  });

  it("CB23: relaunching a session that has been prompted never discards its state", function* () {
    // The live relaunch path, which no replay covers. After the native UI
    // exits, an ACP prompt reattaches and the session holds a real
    // conversation. Relaunching the same instruction layer must hand that same
    // session back — allocating the identity is not a licence to destroy what
    // ACP has since accepted.
    const bound = yield* installBoundStack();
    const first = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });

    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt("continue", { session: "implementor" });
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });
    expect(bound.harness.turns.length).toBe(1);

    const again = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });

    expect(again.nativeSessionId).toBe(first.nativeSessionId);
    // The only discard in this run belongs to the unused shell the first
    // launch superseded. The prompted session's state is never discarded.
    expect(
      bound.harness.closeRequests.filter((request) => request.discardPersistentState === true),
    ).toHaveLength(0);
    // And the second launch resumed rather than created.
    expect(bound.trace.launches[1]?.command.slice(1)).toEqual(["--resume", first.nativeSessionId]);
  });

  it("CB19: a session that has been prompted is not handed to a native UI", function* () {
    // The first ACP prompt claims construction, exactly as `<Session name>`
    // does. Creating a native conversation beside it would split one name
    // across two: the one the document has been talking to, and the one the
    // person is handed.
    const bound = yield* installBoundStack();
    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt("hello", { session: "implementor" });
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });

    const failure = yield* attempt(INSTRUCTIONS, { session: "implementor" });

    expect(failure?.message).toContain("cannot take over a session it did not create");
    expect(bound.trace.records.at(-1)?.failure?.class).toBe("identity-unavailable");
    expect(bound.trace.launches.length).toBe(0);
    // And no identity was allocated for a launch that never happened.
    expect(yield* retainedRoutes(bound.store)).toEqual(["acp-first"]);
  });

  it("CB24: a session an earlier run established through ACP is still ACP's", function* () {
    // A provider scope is invocation-local: a second one knows nothing about
    // the turn the first had, and its cached transcript is empty either way,
    // because native turns are never mirrored back. What survives both scopes
    // is the route — which is why the route, and not an in-memory flag, is
    // what a later launch is refused against.
    const shared = makeStore();
    const routes = yield* useTempDirectory("xmd-cb-");

    yield* scoped(function* () {
      const first = yield* installBoundStack({ sessionStore: shared, store: routes });
      yield* scoped(function* () {
        const stream = yield* Agent.operations.prompt("hello", { session: "implementor" });
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });
      expect(first.harness.turns.length).toBe(1);
      expect(shared.records.size).toBeGreaterThan(0);
    });

    const reopened = yield* installBoundStack({ sessionStore: shared, store: routes });

    const failure = yield* attempt(INSTRUCTIONS, { session: "implementor" });

    expect(failure?.message).toContain("cannot take over a session it did not create");
    expect(reopened.trace.records.at(-1)?.failure?.class).toBe("identity-unavailable");
    // Refused at preparation: before ownership was asked for, before anything
    // detached, and before any child.
    expect(reopened.trace.order).toEqual(["prepared"]);
    expect(reopened.leases).toEqual([]);
    expect(reopened.harness.closeRequests).toEqual([]);
    expect(reopened.trace.launches.length).toBe(0);
    expect(yield* retainedRoutes(routes)).toEqual(["acp-first"]);
  });

  it("CB11: production refuses Claude, because no adapter is advertised on this branch", function* () {
    const bound = yield* installBoundStack({ advertise: [] });

    const failure = yield* attempt(INSTRUCTIONS);

    expect(failure?.message).toContain("not advertised as native-launch capable");
    expect(bound.trace.records[0]?.failure?.class).toBe("unsupported-capability");
    expect(bound.trace.launches.length).toBe(0);
  });
});

/**
 * Tier RC — two provider scopes over one coordination namespace
 * (specs/native-agent-session-launch-spec.md §Ownership and concurrency).
 *
 * Everything above runs one provider. What decides a construction race and
 * what refuses a live one is what happens when two of them share a route
 * store, an ACPX store and one lease — which is the arrangement two `xmd`
 * processes are in, and the only arrangement in which the ordering can be
 * wrong.
 *
 * The lease here is a real exclusive one, held for the acquiring scope and
 * released when it closes; what it is not is the kernel's. Tier LS in
 * `@executablemd/runtime` owns the kernel half, including what a killed owner
 * leaves behind.
 */

interface SharedLease {
  install(): Operation<void>;
  /** Every key ownership was asked for, in order. */
  asked: string[];
  /** Whether the lease for `key` is held right now. */
  held(key: string): boolean;
}

function sharedLease(): SharedLease {
  const holding = new Set<string>();
  const asked: string[] = [];
  return {
    asked,
    held: (key) => holding.has(key),
    install: () =>
      SessionLease.around({
        acquire([key]) {
          return resource<SessionLeaseOutcome>(function* (provide) {
            asked.push(key);
            if (holding.has(key)) {
              yield* provide("busy");
              return;
            }
            holding.add(key);
            yield* ensure(() => {
              holding.delete(key);
            });
            yield* provide("acquired");
          });
        },
      }),
  };
}

/** A route store that holds its first publication until the barrier lifts. */
function gatedRouteStore(
  root: string,
  arrived: { resolve(value: void): void },
  release: Operation<void>,
): SessionRouteStore {
  const inner = createSessionRouteStore(root);
  let held = false;
  return {
    read: (key) => inner.read(key),
    *publish(route) {
      if (!held) {
        held = true;
        arrived.resolve();
        yield* release;
      }
      return yield* inner.publish(route);
    },
  };
}

/** Drain one prompt, so a refusal surfaces where a test can keep it. */
function* ask(content: string, session: string): Operation<Error | undefined> {
  try {
    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt(content, { session });
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
}

describe("Tier RC — two provider scopes over one namespace", () => {
  it("RC1: ACP-first winning the race forbids the native launch, and discards nothing", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    const arrived = withResolvers<void>();
    const release = withResolvers<void>();
    yield* lease.install();

    let refusal: Error | undefined;
    let launched = 0;
    let closes = 0;

    yield* scoped(function* () {
      // The client-allocated launch, whose publication waits at the barrier.
      // It has already read the route and found nothing — the exact window a
      // check-then-act route selection would lose in.
      const native = yield* spawn(() =>
        scoped(function* () {
          const bound = yield* installBoundStack({
            store: routes,
            sessionStore: sessions,
            lease: "inherit",
            routeStore: gatedRouteStore(routes, arrived, release.operation),
          });
          refusal = yield* attempt(INSTRUCTIONS, { session: "implementor" });
          launched = bound.trace.launches.length;
          closes = bound.harness.closeRequests.length;
          return bound.trace.records.at(-1);
        }),
      );

      // Ordinary ACP work in another scope, admitted while the launch waits.
      yield* arrived.operation;
      yield* scoped(function* () {
        yield* installBoundStack({ store: routes, sessionStore: sessions, lease: "inherit" });
        yield* Agent.operations.session("implementor");
        expect(yield* retainedRoutes(routes)).toEqual(["acp-first"]);
      });
      release.resolve();

      const record = yield* native;
      expect(record?.failure?.class).toBe("identity-unavailable");
    });

    expect(refusal?.message).toContain("already retained as acp-first");
    expect(launched).toBe(0);
    expect(closes).toBe(0);
    // The ACP session the other scope established is untouched, and the route
    // still names the path that won.
    expect(sessions.records.size).toBeGreaterThan(0);
    expect(yield* retainedRoutes(routes)).toEqual(["acp-first"]);
  });

  it("RC2: client-native winning makes concurrent ACP work refuse busy, and a retry attaches", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    const started = withResolvers<void>();
    const hold = withResolvers<void>();
    yield* lease.install();

    const launched = yield* scoped(function* (): Operation<string> {
      const native = yield* spawn(() =>
        scoped(function* () {
          yield* installBoundStack({
            store: routes,
            sessionStore: sessions,
            lease: "inherit",
            hold: (function* () {
              started.resolve();
              yield* hold.operation;
            })(),
          });
          return yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
        }),
      );

      // The native UI is running and the launch still owns the session.
      yield* started.operation;
      yield* scoped(function* () {
        const bound = yield* installBoundStack({
          store: routes,
          sessionStore: sessions,
          lease: "inherit",
        });

        const refused = yield* ask("meanwhile", "implementor");

        expect(refused).toBeInstanceOf(SessionBusy);
        expect(refused?.message).toContain("once that owner exits");
        // Nothing waited, nothing created: no unbound shell was established
        // beside the conversation the native UI is in, and no turn started.
        expect(bound.harness.ensureCalls).toEqual([]);
        expect(bound.harness.turns).toEqual([]);
        expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
      });

      hold.resolve();
      const result = yield* native;
      return result.nativeSessionId;
    });

    // The owner has exited, so the same command run again reaches the session
    // — by the exact identity that was retained, never by a substitute.
    yield* scoped(function* () {
      const bound = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });

      expect(yield* ask("what changed?", "implementor")).toBeUndefined();

      expect(bound.harness.ensureCalls).toHaveLength(1);
      expect(bound.harness.ensureCalls[0]?.resumeSessionId).toBe(launched);
      expect(bound.harness.turns).toHaveLength(1);
    });
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  });

  it("RC3: a client-native route is resume-only, and an unloadable one refuses before a turn", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    yield* lease.install();

    let retained = "";
    yield* scoped(function* () {
      yield* installBoundStack({ store: routes, sessionStore: sessions, lease: "inherit" });
      const result = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      retained = result.nativeSessionId;
    });

    yield* scoped(function* () {
      const bound = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });
      // Preparation was interrupted before the native UI created anything, so
      // there is no conversation under the retained identity to load.
      bound.harness.unresumable = true;

      const refused = yield* ask("what changed?", "implementor");

      expect(refused?.message).toContain("could not be resumed");
      // Asked to resume, and refused on the answer rather than on the ask.
      expect(bound.harness.ensureCalls[0]?.resumeSessionId).toBe(retained);
      expect(bound.harness.turns).toEqual([]);
    });

    // No substitute identity, and the route is still what it was.
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  });

  it("RC4: a second launch refuses busy without changing the route, and a later one resumes", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    const started = withResolvers<void>();
    const hold = withResolvers<void>();
    yield* lease.install();

    const first = yield* scoped(function* (): Operation<string> {
      const native = yield* spawn(() =>
        scoped(function* () {
          yield* installBoundStack({
            store: routes,
            sessionStore: sessions,
            lease: "inherit",
            hold: (function* () {
              started.resolve();
              yield* hold.operation;
            })(),
          });
          return yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
        }),
      );
      yield* started.operation;

      yield* scoped(function* () {
        const contender = yield* installBoundStack({
          store: routes,
          sessionStore: sessions,
          lease: "inherit",
        });

        const refused = yield* attempt(INSTRUCTIONS, { session: "implementor" });

        expect(refused?.message).toContain("once that owner exits");
        expect(contender.trace.records.at(-1)?.failure?.class).toBe("session-busy");
        // It refused rather than queued, and it changed nothing on the way:
        // one identity is retained, not two, and no second UI was started.
        expect(contender.trace.order).toEqual(["prepared"]);
        expect(contender.trace.launches).toEqual([]);
        expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
      });

      hold.resolve();
      const result = yield* native;
      return result.nativeSessionId;
    });

    yield* scoped(function* () {
      const later = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });

      const again = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });

      expect(again.nativeSessionId).toBe(first);
      expect(later.trace.launches[0]?.command.slice(1)).toEqual(["--resume", first]);
    });
  });

  it("RC5: a cancelled launch releases ownership only after its child settles", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    const started = withResolvers<void>();
    const forever = withResolvers<void>();
    let childSettled = false;
    yield* lease.install();

    yield* scoped(function* () {
      const native = yield* spawn(() =>
        scoped(function* () {
          yield* installBoundStack({
            store: routes,
            sessionStore: sessions,
            lease: "inherit",
            hold: (function* () {
              started.resolve();
              try {
                yield* forever.operation;
              } finally {
                childSettled = true;
              }
            })(),
          });
          return yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
        }),
      );
      yield* started.operation;

      // While the child is still running, ownership is held: a contender in
      // another scope is refused rather than admitted beside it.
      yield* scoped(function* () {
        const contender = yield* installBoundStack({
          store: routes,
          sessionStore: sessions,
          lease: "inherit",
        });
        yield* attempt(INSTRUCTIONS, { session: "implementor" });
        expect(contender.trace.records.at(-1)?.failure?.class).toBe("session-busy");
      });

      // Cancelling the launch tears its scope down, which is what releases the
      // lease — and the child is torn down first.
      yield* native.halt();
      expect(childSettled).toBe(true);
    });

    // Released, and the route the cancelled attempt published survives it.
    yield* scoped(function* () {
      const later = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });
      const again = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      expect(again.nativeSessionId).toMatch(UUID);
      expect(later.trace.records[0]).toMatchObject({ sessionState: "resumed" });
    });
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  });

  it("RC6: a pre-amendment record that disagrees with its mapping refuses without deleting either", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    yield* lease.install();

    let retained = "";
    yield* scoped(function* () {
      yield* installBoundStack({ store: routes, sessionStore: sessions, lease: "inherit" });
      const result = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      retained = result.nativeSessionId;
    });

    // Rewritten as the shape that existed before routes did, and beside it an
    // ACPX record naming a different conversation — the ambiguous state a
    // pre-amendment worktree can be left in.
    const [file] = (yield* until(readdir(routes))).filter((entry) => entry.endsWith(".json"));
    const parsed = parseSessionRoute(
      JSON.parse(yield* until(readFile(nodePath.join(routes, file!), "utf8"))),
    );
    if (parsed?.route !== "client-native") {
      throw new Error("the launch retained no client-native route");
    }
    yield* until(
      writeFile(
        nodePath.join(routes, file!),
        JSON.stringify(
          {
            schema: "native-session-mapping.v1",
            provider: parsed.provider,
            agent: parsed.agent,
            sessionKey: parsed.sessionKey,
            nativeSessionId: retained,
            identityProvenance: "client-allocated",
            instructionsDigest: parsed.instructionsDigest,
            launcher: parsed.launcher,
            executableBinding: parsed.executableBinding,
          },
          null,
          2,
        ),
      ),
    );
    const record = sessions.records.get(parsed.sessionKey);
    sessions.records.set(parsed.sessionKey, {
      ...record!,
      agentSessionId: "a-conversation-nobody-mapped",
    });

    yield* scoped(function* () {
      const bound = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });

      const refused = yield* attempt(INSTRUCTIONS, { session: "implementor" });

      expect(refused?.message).toContain("names a different conversation");
      expect(bound.trace.records.at(-1)?.failure?.class).toBe("identity-unavailable");
      // Before ensure, before detach, before a child — and nothing removed.
      expect(bound.trace.order).toEqual(["prepared"]);
      expect(bound.harness.ensureCalls).toEqual([]);
      expect(bound.harness.closeRequests).toEqual([]);
      expect(bound.trace.launches).toEqual([]);
    });

    expect(sessions.records.has(parsed.sessionKey)).toBe(true);
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  });

  /**
   * A live ACP turn on a client-native session, settled the way `kind` says.
   *
   * One helper for both, because what is under test is the lease lifetime and
   * that is the same shape either way: held while the turn can still act,
   * released once it cannot, and the route untouched by either.
   */
  function* ownedTurnReleases(kind: "cancelled" | "failed"): Operation<void> {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    yield* lease.install();

    let retained = "";
    yield* scoped(function* () {
      yield* installBoundStack({ store: routes, sessionStore: sessions, lease: "inherit" });
      const result = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
      retained = result.nativeSessionId;
    });

    yield* scoped(function* () {
      const owner = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });
      owner.harness.script({ manual: true });

      const seen: AgentPromptEvent[] = [];
      const prompting = yield* spawn(() =>
        scoped(function* () {
          const stream = yield* Agent.operations.prompt("continue", { session: "implementor" });
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            seen.push(next.value);
            next = yield* subscription.next();
          }
        }),
      );
      yield* when(function* () {
        if (owner.harness.turns.length === 0) {
          throw new Error("the turn has not started yet");
        }
      });

      // The turn can still act, so nobody else may. A contender in another
      // provider scope is refused rather than admitted beside it.
      yield* scoped(function* () {
        const contender = yield* installBoundStack({
          store: routes,
          sessionStore: sessions,
          lease: "inherit",
        });

        const refused = yield* ask("meanwhile", "implementor");

        expect(refused).toBeInstanceOf(SessionBusy);
        expect(contender.harness.ensureCalls).toEqual([]);
        expect(contender.harness.turns).toEqual([]);
      });

      if (kind === "cancelled") {
        yield* prompting.halt();
        // Cancelling the turn cancels it at the runtime, rather than leaving a
        // turn running against a session this provider has stopped watching.
        expect(owner.harness.turns[0]?.cancelled).toBe(true);
      } else {
        owner.harness.turns[0]!.finish([], { status: "completed", stopReason: "max_tokens" });
        yield* prompting;
        // The turn ended, and ended badly. A provider that reported this as an
        // ordinary completion would be releasing ownership on a turn nobody
        // knows the outcome of.
        expect(seen.at(-1)).toMatchObject({ type: "terminal", status: "failed" });
      }
    });

    // Released, and a later explicit turn reaches the same conversation by the
    // exact identity that was retained.
    yield* scoped(function* () {
      const later = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });

      expect(yield* ask("what changed?", "implementor")).toBeUndefined();

      expect(later.harness.ensureCalls).toHaveLength(1);
      expect(later.harness.ensureCalls[0]?.resumeSessionId).toBe(retained);
      expect(later.harness.turns).toHaveLength(1);
    });
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  }

  it("RC8: a cancelled ACP turn holds ownership until it can no longer act", function* () {
    yield* ownedTurnReleases("cancelled");
  });

  it("RC9: a failed ACP turn holds ownership until it can no longer act", function* () {
    yield* ownedTurnReleases("failed");
  });

  it("RC10: a native child that exits badly releases ownership and keeps its route", function* () {
    // A launch can fail on its own terms — the person closed the UI with an
    // error — without that saying anything about the conversation. The route
    // and the identity survive it, and so does the next invocation's ability
    // to acquire the session.
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    const started = withResolvers<void>();
    const hold = withResolvers<void>();
    let childSettled = false;
    yield* lease.install();

    const first = yield* scoped(function* (): Operation<string> {
      const failing = yield* spawn(() =>
        scoped(function* () {
          const bound = yield* installBoundStack({
            store: routes,
            sessionStore: sessions,
            lease: "inherit",
            exitCode: 9,
            hold: (function* () {
              started.resolve();
              try {
                yield* hold.operation;
              } finally {
                childSettled = true;
              }
            })(),
          });
          yield* attempt(INSTRUCTIONS, { session: "implementor" });
          return bound;
        }),
      );
      yield* started.operation;

      // While the child is still running, ownership is held.
      yield* scoped(function* () {
        const contender = yield* installBoundStack({
          store: routes,
          sessionStore: sessions,
          lease: "inherit",
        });
        yield* attempt(INSTRUCTIONS, { session: "implementor" });
        expect(contender.trace.records.at(-1)?.failure?.class).toBe("session-busy");
      });

      hold.resolve();
      const bound = yield* failing;

      // The child settled before anything released, and its status is what
      // the launch's last retained phase reports.
      expect(childSettled).toBe(true);
      expect(bound.trace.records.at(-1)).toMatchObject({ phase: "exited", exitCode: 9 });
      const prepared = bound.trace.records.find((record) => record.phase === "prepared");
      return (prepared as PreparedLaunchRecord).nativeSessionId;
    });

    // Ownership went back, and what the failed launch retained is still what
    // the session is: the same identity, resumed rather than allocated again.
    yield* scoped(function* () {
      const later = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });

      const again = yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });

      expect(again.nativeSessionId).toBe(first);
      expect(later.trace.launches[0]?.command.slice(1)).toEqual(["--resume", first]);
    });
    expect(yield* retainedRoutes(routes)).toEqual(["client-native"]);
  });

  it("RC7: a failed ACP ensure leaves the ACP-first claim standing", function* () {
    const routes = yield* useTempDirectory("xmd-rc-");
    const sessions = makeStore();
    const lease = sharedLease();
    yield* lease.install();

    yield* scoped(function* () {
      const bound = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });
      bound.harness.ensureFailure = new Error("the agent could not be reached");

      const refused = yield* ask("hello", "implementor");

      expect(refused?.message).toContain("could not be reached");
      // The claim was published before ACPX was contacted, so it survives an
      // ensure that never established anything.
      expect(yield* retainedRoutes(routes)).toEqual(["acp-first"]);
    });

    // And it is still ACP's session: a launch cannot take it over on the
    // strength of the provider having failed.
    yield* scoped(function* () {
      const bound = yield* installBoundStack({
        store: routes,
        sessionStore: sessions,
        lease: "inherit",
      });

      const refused = yield* attempt(INSTRUCTIONS, { session: "implementor" });

      expect(refused?.message).toContain("cannot take over a session it did not create");
      expect(bound.trace.records.at(-1)?.failure?.class).toBe("identity-unavailable");
      expect(bound.trace.launches).toEqual([]);
    });
    expect(yield* retainedRoutes(routes)).toEqual(["acp-first"]);
  });
});

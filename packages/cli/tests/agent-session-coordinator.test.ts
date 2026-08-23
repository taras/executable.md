/**
 * Tier HC — which hosts can own an agent session, and what the others do
 * (specs/native-agent-session-launch-spec.md §Hosts).
 *
 * This file runs under all three runtimes, because the claim it makes is about
 * the differences between them: Deno and the compiled binary build a
 * coordinator, Node and Bun build none, and a provider handed none refuses
 * every advertised provider-returned operation before contacting an agent.
 * Running it on one runtime would prove one side of that and assume the other.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@executablemd/core";
import type {
  AgentLaunchRequest,
  AgentProviderAuthority,
  LaunchRecord,
  PreparedLaunchRecord,
} from "@executablemd/core";
import {
  API,
  createDenoAgentSessionCoordinator,
  hasDenoAgentSessionCoordinator,
  installControlledLauncher,
} from "@executablemd/runtime";
import type { AgentSessionCoordinator } from "@executablemd/runtime";
import {
  ADVERTISED_NATIVE_LAUNCH,
  createAcpxProvider,
  createDenoSessionRouteStore,
  createMemorySessionRouteStore,
} from "@executablemd/acp";
import type { AgentSessionRouteStore, NativeAdapter } from "@executablemd/acp";
import type { NativeLaunchRequest } from "@executablemd/runtime";
import {
  sessionCoordinatorRoot,
  useSessionCoordinator,
  useSessionRouteStore,
} from "../src/session-coordinator.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Whether this is the runtime that can take a kernel-released advisory lock. */
function onDeno(): boolean {
  const found: unknown = Reflect.get(globalThis, "Deno");
  return typeof found === "object" && found !== null;
}

function entrypoint(name: string): Operation<string> {
  return readTextFile(join(SRC, name));
}

/** Enough of a runtime to prove the provider never reached one. */
interface RuntimeProbe {
  /**
   * Every way this runtime could have been contacted at all.
   *
   * Asking whether an agent is available spawns a probe child, and that is
   * provider work on a session whose construction nothing has settled yet.
   */
  doctors: number;
  runtimes: number;
  ensures: number;
  closes: number;
}

function probeRuntime(probe: RuntimeProbe) {
  return () => {
    probe.runtimes += 1;
    return {
      doctor() {
        probe.doctors += 1;
        return Promise.resolve({ ok: true, agents: [] } as never);
      },
      ensureSession() {
        probe.ensures += 1;
        return Promise.reject(new Error("this test's provider must not reach a runtime"));
      },
      startTurn() {
        throw new Error("this test's provider must not start a turn");
      },
      runTurn() {
        throw new Error("this test's provider must not start a turn");
      },
      cancel() {
        return Promise.resolve();
      },
      close() {
        probe.closes += 1;
        return Promise.resolve();
      },
    } as never;
  };
}

/** What core does with each phase, minus the journal. */
function collectingAuthority(records: LaunchRecord[]): AgentProviderAuthority {
  return {
    // These suites route launches, never a `<Session>` placement. Throwing
    // rather than answering means a placement that did reach here fails
    // loudly instead of being handed an identity nobody derived.
    sessionIdentity: () => {
      throw new Error("this stub authority routes no session placement");
    },
    *perform(_request, phases) {
      const prepared = yield* phases.prepare();
      records.push(prepared);
    },
    // deno-lint-ignore require-yield
    *refuse(_request, preparation) {
      records.push(preparation);
    },
  };
}

/**
 * The whole phase sequence, the way core drives it.
 *
 * `collectingAuthority` stops after preparation, which is all the ownership
 * cases need. A case about what the host hands the launcher has to go the
 * distance, and stops at the first phase that carries a failure — exactly as
 * the real authority does before deriving a result.
 */
function performingAuthority(records: LaunchRecord[]): AgentProviderAuthority {
  return {
    // As above: these suites route launches, never a `<Session>` placement.
    sessionIdentity: () => {
      throw new Error("this stub authority routes no session placement");
    },
    *perform(_request, phases) {
      const prepared = yield* phases.prepare();
      records.push(prepared);
      if (prepared.failure) {
        return;
      }
      const detached = yield* phases.detach(prepared);
      records.push(detached);
      if (detached.failure) {
        return;
      }
      records.push(yield* phases.exit(prepared));
    },
    // deno-lint-ignore require-yield
    *refuse(_request, preparation) {
      records.push(preparation);
    },
  };
}

function launchRequest(agent = "claude"): AgentLaunchRequest {
  const request = {
    instructions: "You are the repository implementor.",
    agent,
    cwd: "/work",
    additionalDirectories: [] as readonly string[],
    permissionMode: "deny-all" as const,
    with: () => request,
  };
  return request;
}

/**
 * A Claude-shaped adapter whose provider returns the identity.
 *
 * The merged #518 shape, declared here because the real Claude adapter names
 * its own sessions now. Keeping it is what lets these cases say that a
 * provider-returned agent gained no new host requirement.
 */
const PROVIDER_RETURNED: NativeAdapter = {
  launcher: "claude",
  identity: "provider-returned",
  resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
};

/** A Claude-shaped adapter that names its own sessions. */
const CLIENT_ALLOCATED: NativeAdapter = {
  launcher: "claude",
  identity: "client-allocated",
  allocate: () => randomUUID(),
  create: (nativeSessionId, instructionFile) => [
    "claude",
    "--session-id",
    nativeSessionId,
    "--system-prompt-file",
    instructionFile,
  ],
  resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
};

/**
 * A route store that records every operation performed on it.
 *
 * "Performs no route work" is a claim about absence, and absence is only
 * provable where something was watching.
 */
function countingRoutes(): { store: AgentSessionRouteStore; operations: string[] } {
  const inner = createMemorySessionRouteStore();
  const operations: string[] = [];
  return {
    operations,
    store: {
      *read(key) {
        operations.push("read");
        return yield* inner.read(key);
      },
      *publish(candidate) {
        operations.push("publish");
        return yield* inner.publish(candidate);
      },
    },
  };
}

/**
 * Run one launch against a provider built with or without a coordinator.
 *
 * `defaults: true` passes neither an advertisement nor an adapter, so what the
 * provider serves is the package's own `ADVERTISED_NATIVE_LAUNCH` and the
 * built-in Claude adapter — which is what an actual host assembles, and the
 * only way these cases can say anything about the shipped default.
 */
function* launchUnder(
  coordinator: AgentSessionCoordinator | undefined,
  records: LaunchRecord[],
  probe: RuntimeProbe,
  options: {
    adapter?: NativeAdapter;
    routeStore?: AgentSessionRouteStore;
    defaults?: boolean;
    launched?: NativeLaunchRequest[];
    agent?: string;
    /** Drive every phase, not only preparation. */
    perform?: boolean;
  } = {},
): Operation<void> {
  const agent = options.agent ?? "claude";
  yield* scoped(function* () {
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *cwd() {
        return "/work";
      },
    });
    yield* installControlledLauncher({
      record: (request) => options.launched?.push(request),
    });
    const factory = createAcpxProvider({
      createRuntime: probeRuntime(probe),
      sessionStore: {
        load: () => Promise.resolve(undefined),
        save: () => Promise.resolve(),
      },
      agentRegistry: {
        resolve: () => "claude-cmd",
        list: () => ["claude"],
      },
      ...(options.defaults
        ? {}
        : {
            advertiseNativeLaunch: ["claude"],
            nativeAdapters: { claude: options.adapter ?? PROVIDER_RETURNED },
          }),
      ...(coordinator ? { coordinator } : {}),
      ...(options.routeStore ? { routeStore: options.routeStore } : {}),
    });
    yield* factory(
      { defaultAgent: agent, permissionMode: "deny-all" },
      options.perform ? performingAuthority(records) : collectingAuthority(records),
    );
    yield* Agent.operations.launch(launchRequest(agent));
  });
}

/** A directory this test owns, removed with it. */
function* useOwnedRoot(label: string): Operation<string> {
  const root = join(tmpdir(), `xmd-${label}-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("Tier HC — host session ownership", () => {
  it("HC1: only a host with advisory locking builds a coordinator", function* () {
    expect(hasDenoAgentSessionCoordinator()).toBe(onDeno());
    expect(useSessionCoordinator() === undefined).toBe(!onDeno());
  });

  it("HC2: the coordination namespace is the machine-wide one, not a run's", function* () {
    const root = sessionCoordinatorRoot();
    // Found by every XMD process on the host, or it coordinates nothing.
    expect(root.endsWith(join(".acpx", "xmd-native-sessions", "v1"))).toBe(true);
    expect(root.includes("/work")).toBe(false);
  });

  it("HC3: a provider with no coordinator refuses before contacting the agent", function* () {
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { ensures: 0, closes: 0, doctors: 0, runtimes: 0 };
    yield* launchUnder(undefined, records, probe);

    const failure = records.find((record) => record.failure)?.failure;
    expect(failure?.class).toBe("unsupported-capability");
    // The refusal is what a Node or Bun host produces, and it costs nothing:
    // no ACP session was created, and none was closed.
    expect(probe.ensures).toBe(0);
    expect(probe.closes).toBe(0);
  });

  it("HC4: a coordinator this host can build gets past the ownership question", function* () {
    if (!onDeno()) {
      // Node and Bun build none at all, which HC1 and HC3 already say.
      return;
    }
    // Rooted in a directory this test owns, never the machine-wide one: a
    // launch that stops mid-handoff leaves a recovery tombstone by design, and
    // planting one of those in the user's home is not a test's business.
    const root = join(tmpdir(), `xmd-hc-${randomUUID()}`);
    yield* ensureDir(root);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { ensures: 0, closes: 0, doctors: 0, runtimes: 0 };
    let reached = false;
    try {
      yield* launchUnder(createDenoAgentSessionCoordinator(root), records, probe);
    } catch (error) {
      reached = error instanceof Error && error.message.includes("must not reach a runtime");
    }

    // Ownership was granted, so the launch got as far as the runtime this test
    // deliberately makes unreachable — it did not stop at the coordinator.
    expect(reached).toBe(true);
    expect(probe.ensures).toBe(1);
    expect(records.find((record) => record.failure)).toBe(undefined);
  });

  it("HC6: an agent that names its own sessions needs a route store too", function* () {
    // Fail-closed means what this agent actually needs. A host that can say who
    // owns the session but not how it was constructed cannot act on one a
    // native UI may be in — and it says so before any provider effect.
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { ensures: 0, closes: 0, doctors: 0, runtimes: 0 };
    yield* launchUnder(
      onDeno()
        ? createDenoAgentSessionCoordinator(join(tmpdir(), `xmd-hc6-${randomUUID()}`))
        : undefined,
      records,
      probe,
      { adapter: CLIENT_ALLOCATED },
    );

    const failure = records.find((record) => record.failure)?.failure;
    expect(failure?.class).toBe("unsupported-capability");
    if (onDeno()) {
      expect(failure?.message).toContain("construction routes");
    }
    // Zero provider work: no runtime was built and no probe child was spawned.
    expect(probe.runtimes).toBe(0);
    expect(probe.doctors).toBe(0);
    expect(probe.ensures).toBe(0);
    expect(probe.closes).toBe(0);
  });

  it("HC7: a provider-returned agent performs no route work at all", function* () {
    // #518's path is unchanged. It uses the coordinator and the existing ACP
    // path, and gains no route requirement merely because the same provider
    // package also serves an agent that names its own sessions.
    if (!onDeno()) {
      return;
    }
    const root = join(tmpdir(), `xmd-hc7-${randomUUID()}`);
    yield* ensureDir(root);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { ensures: 0, closes: 0, doctors: 0, runtimes: 0 };
    const counted = countingRoutes();

    try {
      yield* launchUnder(createDenoAgentSessionCoordinator(root), records, probe, {
        routeStore: counted.store,
      });
    } catch {
      // The probe runtime is deliberately unreachable; what matters is what was
      // touched on the way there.
    }

    expect(probe.ensures).toBe(1);
    expect(counted.operations).toEqual([]);
  });

  it("HC8: the shipped default advertises claude, and Codex stays off it", function* () {
    // What a host actually assembles. A case that injected an advertisement
    // would prove the mechanism and say nothing about what ships.
    expect([...ADVERTISED_NATIVE_LAUNCH]).toEqual(["claude"]);
    expect(ADVERTISED_NATIVE_LAUNCH).not.toContain("codex");
  });

  it("HC9: a default Claude launch reaches the launcher here, and refuses elsewhere", function* () {
    const root = yield* useOwnedRoot("hc9");
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { ensures: 0, closes: 0, doctors: 0, runtimes: 0 };
    const launched: NativeLaunchRequest[] = [];
    // Only this host assembles both halves. Node and Bun build neither, which
    // is what makes the same call refuse there.
    const routeStore = onDeno() ? createDenoSessionRouteStore(root) : undefined;

    yield* launchUnder(
      onDeno() ? createDenoAgentSessionCoordinator(root) : undefined,
      records,
      probe,
      { defaults: true, perform: true, launched, ...(routeStore ? { routeStore } : {}) },
    );

    if (!onDeno()) {
      // Advertised and unservable is a refusal, and it costs nothing: no
      // runtime was built, no availability probe spawned, no identity
      // allocated and no child started.
      const failure = records.find((record) => record.failure)?.failure;
      expect(failure?.class).toBe("unsupported-capability");
      expect(launched).toEqual([]);
      expect(probe.runtimes).toBe(0);
      expect(probe.doctors).toBe(0);
      expect(probe.ensures).toBe(0);
      expect(probe.closes).toBe(0);
      return;
    }

    // The whole way to the launcher, and nothing was created through ACP on the
    // way: a session Claude names is materialized by the native process.
    expect(records.find((record) => record.failure)).toBe(undefined);
    expect(probe.runtimes).toBe(0);
    expect(probe.ensures).toBe(0);
    expect(launched.length).toBe(1);
    const command = launched[0]!.command;
    expect(command[0]).toBe("claude");
    expect(command[1]).toBe("--session-id");
    expect(command[3]).toBe("--system-prompt-file");
    // The prepared text crossed as a path, so it is in neither surface another
    // process can read.
    expect(command.some((argument) => argument.includes("repository implementor"))).toBe(false);

    // Narrowed by the discriminant the union already carries, so reading
    // `nativeSessionId` is the type saying it is there rather than this test.
    const prepared = records.find(
      (record): record is PreparedLaunchRecord => record.phase === "prepared",
    );
    expect(prepared).toMatchObject({
      identityProvenance: "client-allocated",
      launcher: "claude",
      sessionState: "created",
    });
    expect(command[2]).toBe(prepared?.nativeSessionId);
  });

  it("HC10: an unadvertised agent keeps ordinary behavior on every runtime", function* () {
    // Codex has a command shape and no advertisement, so nothing about session
    // ownership applies to it — including on the host that could have owned it.
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { ensures: 0, closes: 0, doctors: 0, runtimes: 0 };
    yield* launchUnder(undefined, records, probe, { defaults: true, agent: "codex" });

    const failure = records.find((record) => record.failure)?.failure;
    expect(failure?.class).toBe("unsupported-capability");
    expect(failure?.message).toContain("not advertised");
  });

  it("HC5: the Deno and compiled entrypoints install one; Node and Bun do not", function* () {
    for (const name of ["deno.ts", "compiled.ts"]) {
      expect((yield* entrypoint(name)).includes("useSessionCoordinator()")).toBe(true);
    }
    for (const name of ["node.ts", "bun.ts"]) {
      expect((yield* entrypoint(name)).includes("useSessionCoordinator")).toBe(false);
    }
  });
});

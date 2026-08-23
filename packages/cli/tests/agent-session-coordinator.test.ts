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
import type { AgentLaunchRequest, AgentProviderAuthority, LaunchRecord } from "@executablemd/core";
import {
  API,
  createDenoAgentSessionCoordinator,
  hasDenoAgentSessionCoordinator,
  installControlledLauncher,
} from "@executablemd/runtime";
import type { AgentSessionCoordinator } from "@executablemd/runtime";
import { createAcpxProvider, createMemorySessionRouteStore } from "@executablemd/acp";
import type { AgentSessionRouteStore } from "@executablemd/acp";
import type { ExecutableObserver } from "@executablemd/runtime";
import { sessionCoordinatorRoot, useSessionCoordinator } from "../src/session-coordinator.ts";

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
  /** Every way this runtime could have been contacted at all. */
  doctors: number;
  ensures: number;
  closes: number;
  turns: number;
  /**
   * ACP session records read and written.
   *
   * Resolving which session a caller meant walks candidate keys and loads each
   * one, so a host that refuses only after finding a placement has already read
   * the store of a session it may not act on. Reaching an agent is not the
   * boundary; touching the session's own state is.
   */
  loads: number;
  saves: number;
}

function countingStore(probe: RuntimeProbe) {
  return {
    load: () => {
      probe.loads += 1;
      return Promise.resolve(undefined);
    },
    save: () => {
      probe.saves += 1;
      return Promise.resolve();
    },
  };
}

function probeRuntime(probe: RuntimeProbe) {
  return () =>
    ({
      doctor() {
        probe.doctors += 1;
        return Promise.resolve({ ok: true, agents: [] } as never);
      },
      ensureSession() {
        probe.ensures += 1;
        return Promise.reject(new Error("this test's provider must not reach a runtime"));
      },
      startTurn() {
        probe.turns += 1;
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
    }) as never;
}

/** What core does with each phase, minus the journal. */
function collectingAuthority(records: LaunchRecord[]): AgentProviderAuthority {
  return {
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
 * What core does with a launch whose preparation the journal already holds.
 *
 * The retained record is the one an interrupted client-allocated launch leaves
 * behind, so nothing but detach and exit is asked of the provider — which is
 * exactly the surface a refusal placed inside `prepare()` would never see.
 */
function replayingAuthority(records: LaunchRecord[]): AgentProviderAuthority {
  const prepared: LaunchRecord = {
    phase: "prepared",
    agent: "claude",
    sessionKey: `xmd:v1:${"a".repeat(16)}`,
    provider: "acpx",
    nativeSessionId: "11111111-2222-3333-4444-555555555555",
    sessionState: "created",
    instructionChannel: "claude.systemPromptFile",
    instructionReconciliation: "installed",
    identityProvenance: "client-allocated",
    instructionsDigest: "f".repeat(64),
    instructions: "You are the repository implementor.",
    cwd: "/work",
    additionalDirectories: [],
    permissionMode: "deny-all",
    launcher: "claude",
  };
  return {
    *perform(_request, phases) {
      records.push(prepared);
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

function launchRequest(): AgentLaunchRequest {
  const request = {
    instructions: "You are the repository implementor.",
    agent: "claude",
    cwd: "/work",
    additionalDirectories: [] as readonly string[],
    permissionMode: "deny-all" as const,
    with: () => request,
  };
  return request;
}

/** Run one launch against a provider built with or without a coordinator. */
function* launchUnder(
  coordinator: AgentSessionCoordinator | undefined,
  records: LaunchRecord[],
  probe: RuntimeProbe,
  routeStore?: AgentSessionRouteStore,
  executableObserver?: ExecutableObserver,
): Operation<void> {
  yield* scoped(function* () {
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *cwd() {
        return "/work";
      },
    });
    yield* installControlledLauncher();
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
      advertiseNativeLaunch: ["claude"],
      ...(coordinator ? { coordinator } : {}),
      ...(routeStore ? { routeStore } : {}),
      ...(executableObserver ? { executableObserver } : {}),
    });
    yield* factory(
      { defaultAgent: "claude", permissionMode: "deny-all" },
      collectingAuthority(records),
    );
    yield* Agent.operations.launch(launchRequest());
  });
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
    const probe: RuntimeProbe = { doctors: 0, ensures: 0, closes: 0, turns: 0, loads: 0, saves: 0 };
    yield* launchUnder(undefined, records, probe);

    const failure = records.find((record) => record.failure)?.failure;
    expect(failure?.class).toBe("unsupported-capability");
    // The refusal is what a Node or Bun host produces, and it costs nothing:
    // no ACP session was created, and none was closed.
    expect(probe.ensures).toBe(0);
    expect(probe.closes).toBe(0);
  });

  it("HC4: a fully assembled host gets past the ownership question", function* () {
    if (!onDeno()) {
      // Node and Bun build none of it, which HC1 and HC3 already say.
      return;
    }
    // Rooted in a directory this test owns, never the machine-wide one: a
    // launch that stops mid-handoff leaves a recovery tombstone by design, and
    // planting one of those in the user's home is not a test's business.
    const root = join(tmpdir(), `xmd-hc-${randomUUID()}`);
    yield* ensureDir(root);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { doctors: 0, ensures: 0, closes: 0, turns: 0, loads: 0, saves: 0 };

    yield* launchUnder(
      createDenoAgentSessionCoordinator(root),
      records,
      probe,
      createMemorySessionRouteStore(),
      // The whole assembly: this host can say who owns the session, how it was
      // constructed, and which build it would run.
      {
        // deno-lint-ignore require-yield
        *observe() {
          return {
            path: "/observed/claude",
            digest: { algorithm: "sha256", value: "d".repeat(64) },
            versionOutput: "2.1.235 (Claude Code)\n",
          };
        },
      },
    );

    // Ownership, the route and the build were all answered, so the launch
    // prepared a session rather than refusing for a missing capability. Claude
    // allocates its own identity, so nothing was created through ACP.
    const prepared = records.find((record) => record.phase === "prepared");
    expect(prepared).toBeDefined();
    expect(prepared?.failure).toBe(undefined);
    expect((prepared as { identityProvenance?: string })?.identityProvenance).toBe(
      "client-allocated",
    );
    expect(probe.ensures).toBe(0);
  });

  it("HC5: the Deno and compiled entrypoints install one; Node and Bun do not", function* () {
    for (const name of ["deno.ts", "compiled.ts"]) {
      expect((yield* entrypoint(name)).includes("useSessionCoordinator()")).toBe(true);
    }
    for (const name of ["node.ts", "bun.ts"]) {
      expect((yield* entrypoint(name)).includes("useSessionCoordinator")).toBe(false);
    }
  });

  it("HC7: an unassembled host touches nothing, on any of the four surfaces", function* () {
    // Session, subscribed Prompt, launch and incomplete replay all refuse
    // before the adapter is contacted at all — not merely before ensure. Asking
    // whether an agent is available spawns a probe child, and that is provider
    // work on a session a native UI may be in. So is resolving which session
    // was meant, which reads the ACP session store; a host that may not act
    // must not read that store to learn what it is refusing.
    for (const surface of ["session", "prompt", "launch", "replay"] as const) {
      const probe: RuntimeProbe = {
        doctors: 0,
        ensures: 0,
        closes: 0,
        turns: 0,
        loads: 0,
        saves: 0,
      };
      const records: LaunchRecord[] = [];
      let refused = false;

      yield* scoped(function* () {
        yield* API.Env.around({
          // deno-lint-ignore require-yield
          *cwd() {
            return "/work";
          },
        });
        yield* installControlledLauncher();
        // No coordinator, no route store, no observer: the Node and Bun shape.
        const factory = createAcpxProvider({
          createRuntime: probeRuntime(probe),
          sessionStore: countingStore(probe),
          agentRegistry: { resolve: () => "claude-cmd", list: () => ["claude"] },
          advertiseNativeLaunch: ["claude"],
        });
        yield* factory(
          { defaultAgent: "claude", permissionMode: "deny-all" },
          surface === "replay" ? replayingAuthority(records) : collectingAuthority(records),
        );

        try {
          if (surface === "session") {
            yield* Agent.operations.session();
          } else if (surface === "prompt") {
            const stream = yield* Agent.operations.prompt("hello", {});
            const subscription = yield* stream;
            let next = yield* subscription.next();
            while (!next.done) {
              next = yield* subscription.next();
            }
          } else {
            // `replay` differs in what the authority hands back, not in what is
            // asked for: its journal already retained the preparation, so a
            // host that only refused inside `prepare()` would let it through.
            yield* Agent.operations.launch(launchRequest());
          }
        } catch {
          refused = true;
        }
      });

      // Read-only agent resolution still works; nothing else does.
      const answered =
        surface === "launch" || surface === "replay"
          ? records.find((record) => record.failure) !== undefined
          : refused;
      expect([surface, answered]).toEqual([surface, true]);
      expect([surface, probe.doctors]).toEqual([surface, 0]);
      expect([surface, probe.ensures]).toEqual([surface, 0]);
      expect([surface, probe.turns]).toEqual([surface, 0]);
      expect([surface, probe.closes]).toEqual([surface, 0]);
      expect([surface, probe.loads]).toEqual([surface, 0]);
      expect([surface, probe.saves]).toEqual([surface, 0]);
    }
  });

  it("HC6: a half-assembled host refuses an advertised agent", function* () {
    // Fail-closed means all of it. A host that can say who owns a session but
    // not how it was constructed cannot act on one a native UI may be in.
    const records: LaunchRecord[] = [];
    const probe: RuntimeProbe = { doctors: 0, ensures: 0, closes: 0, turns: 0, loads: 0, saves: 0 };
    yield* launchUnder(
      onDeno()
        ? createDenoAgentSessionCoordinator(join(tmpdir(), `xmd-hc6-${randomUUID()}`))
        : undefined,
      records,
      probe,
      // No route store.
    );

    expect(records.find((record) => record.failure)?.failure?.class).toBe("unsupported-capability");
    expect(probe.ensures).toBe(0);
  });
});

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
import { createAcpxProvider } from "@executablemd/acp";
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
  ensures: number;
  closes: number;
}

function probeRuntime(probe: RuntimeProbe) {
  return () =>
    ({
      doctor() {
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
    const probe: RuntimeProbe = { ensures: 0, closes: 0 };
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
    const probe: RuntimeProbe = { ensures: 0, closes: 0 };
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

  it("HC5: the Deno and compiled entrypoints install one; Node and Bun do not", function* () {
    for (const name of ["deno.ts", "compiled.ts"]) {
      expect((yield* entrypoint(name)).includes("useSessionCoordinator()")).toBe(true);
    }
    for (const name of ["node.ts", "bun.ts"]) {
      expect((yield* entrypoint(name)).includes("useSessionCoordinator")).toBe(false);
    }
  });
});

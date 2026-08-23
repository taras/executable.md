/**
 * The per-boundary provider for `<TestAgent>` (specs/test-agent-spec.md
 * §Scenarios): the production ACPX provider composed with an in-memory
 * session store and a dynamic registry whose resolve() embeds the pending
 * scenario route into the worker command. Routing flows through the
 * provider's `withSessionRoute` hook: the route slot is held only across the
 * provider's registry-dependent work (preparation and ensure/session
 * validation + turn start), released while the provider waits on the
 * per-session queue and during turn consumption.
 */

import { randomUUID } from "node:crypto";
import type { Operation } from "effection";
import { useAcpxProvider } from "@executablemd/acp";
import type {
  AcpxProvider,
  AcpxProviderDependencies,
  SessionRouteContext,
} from "@executablemd/acp";
import type { NativeAdapter } from "@executablemd/acp";
import { useRouteSlot } from "./route-slot.ts";
import type { AgentSessionCoordinator, ExecutableObserver } from "@executablemd/runtime";
import type { AgentSessionRouteStore } from "@executablemd/acp";
import type { AcpAgentRegistry, AcpSessionRecord, AcpSessionStore } from "acpx/runtime";

/**
 * The name `<TestAgent>` registers its partition-selecting factory under.
 *
 * A name, not a capability: registration is scope-local, so this shadows any
 * outer provider of the same name for the `<TestAgent>` that installed it and
 * touches nothing beside it.
 */
export const TEST_AGENT_PROVIDER = "test-agent";

export function createMemorySessionStore(): AcpSessionStore {
  const records = new Map<string, AcpSessionRecord>();
  return {
    load(sessionId) {
      return Promise.resolve(records.get(sessionId));
    },
    save(record) {
      records.set(record.acpxRecordId, record);
      return Promise.resolve();
    },
  };
}

/**
 * One registry-dependent operation's place in the scenario world.
 *
 * The route is what `registry.resolve()` will read, and that read is
 * synchronous — so acquiring the scenario behind it happens here, where
 * suspending is allowed, rather than in the resolver. `resolved` is told what
 * the pinned operation produced while the route is still held, which is what
 * lets a session be recorded against the scenario that served it without the
 * two ever being paired by a third party.
 */
export interface SessionRouting {
  route: string;
  resolved(value: unknown): void;
}

export interface TestAgentProviderOptions {
  defaultAgent: string;
  agents: string[];
  workerCommand: string[];
  probeRoute: string;
  /** Place one registry-dependent operation. May suspend to provision. */
  routeFor(context: SessionRouteContext): Operation<SessionRouting>;
  /** Who owns this partition's sessions. Absent refuses every advertised one. */
  coordinator?: AgentSessionCoordinator;
  /** How this partition's sessions were constructed. Its own, like the rest. */
  routeStore?: AgentSessionRouteStore;
  /** Which build this partition observes. Its own controlled one. */
  executableObserver?: ExecutableObserver;
  dependencies?: AcpxProviderDependencies;
}

/**
 * The launcher identity a test agent's native UI would have.
 *
 * A real adapter is advertised only after an integration proof against the
 * installed CLI. This one is advertised unconditionally because there is
 * nothing to prove: the worker asserts the native identity itself, and the
 * host a test installs never starts a UI at all — which is exactly the
 * separation the advertisement gate exists to keep.
 */
export const TEST_AGENT_LAUNCHER = "test-agent";

/**
 * The agent name whose sessions are constructed the way Claude's are.
 *
 * A second adapter rather than a reclassification: the ordinary test agent's
 * worker asserts its own identity and has no executable to bind, and that
 * contract still has to hold. This one exists so the client-allocated path —
 * XMD choosing the identity, binding a build, and creating the session through
 * a native process rather than through ACP — can be authored in Markdown
 * without a real Claude.
 */
export const TEST_AGENT_CLIENT_NATIVE = "test-agent-client-native";

/** The version this controlled build reports. Shaped like a real one. */
export const TEST_AGENT_BUILD_VERSION = "9.9.9 (Test Agent)";

/**
 * A controlled adapter that allocates its own session identity.
 *
 * Everything a bound adapter needs, in the test agent's dialect: a command
 * whose build is observed, a pinned ACP adapter command, a canonical version
 * parser, the argv that creates and resumes, and the environment the ACP child
 * needs to run the same build.
 */
export const TEST_AGENT_CLIENT_NATIVE_ADAPTER: NativeAdapter = {
  launcher: TEST_AGENT_LAUNCHER,
  identity: "client-allocated",
  resume: (nativeSessionId) => ["xmd-test-agent-ui", "--resume", nativeSessionId],
  binding: {
    command: "xmd-test-agent-ui",
    adapterCommand: "xmd-test-agent-acp",
    allocate: () => randomUUID(),
    version: (output) => {
      const found = output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^\d+\.\d+\.\d+ \(Test Agent\)$/.test(line));
      return found;
    },
    create: (nativeSessionId, instructionFile) => [
      "--session-id",
      nativeSessionId,
      "--system-prompt-file",
      instructionFile,
    ],
    resume: (nativeSessionId) => ["--resume", nativeSessionId],
    environment: (livePath) => ({ XMD_TEST_AGENT_EXECUTABLE: livePath }),
  },
};

export const TEST_AGENT_NATIVE_ADAPTER: NativeAdapter = {
  launcher: TEST_AGENT_LAUNCHER,
  // The worker asserts the identity itself, exactly as a provider-returned
  // agent does. #519's client-allocated path belongs to adapters that bind an
  // executable build, and this one has no executable to bind.
  identity: "provider-returned",
  resume: (nativeSessionId) => ["xmd-test-agent-ui", "--resume", nativeSessionId],
};

export function* useTestAgentProvider(options: TestAgentProviderOptions): Operation<AcpxProvider> {
  let pendingRoute: string | undefined;
  const routeSlot = yield* useRouteSlot();

  // ACPX tokenizes the command on whitespace with quote support, so
  // command segments containing spaces (e.g. a binary path) are quoted.
  const quote = (segment: string) => (/\s/.test(segment) ? `"${segment}"` : segment);
  const registry: AcpAgentRegistry = {
    resolve() {
      const route = pendingRoute ?? options.probeRoute;
      return [...options.workerCommand.map(quote), "--connect", route].join(" ");
    },
    list() {
      return options.agents;
    },
  };

  return yield* useAcpxProvider(
    { defaultAgent: options.defaultAgent, permissionMode: "deny-all" },
    {
      sessionStore: createMemorySessionStore(),
      agentRegistry: registry,
      advertiseNativeLaunch: options.agents,
      nativeAdapters: Object.fromEntries(
        options.agents.map((name) => [
          name,
          name === TEST_AGENT_CLIENT_NATIVE
            ? TEST_AGENT_CLIENT_NATIVE_ADAPTER
            : TEST_AGENT_NATIVE_ADAPTER,
        ]),
      ),
      ...(options.executableObserver ? { executableObserver: options.executableObserver } : {}),
      // withSlot bounds the route mutex to the hook's op without a scope
      // of its own — op's acquisitions (turn resources) belong to the
      // provider's subscriber scope and outlive the critical section.
      withSessionRoute: (context, op) =>
        routeSlot.withSlot(function* () {
          const routing = yield* options.routeFor(context);
          pendingRoute = routing.route;
          try {
            const value = yield* op();
            // Reported before the slot advances, so the next operation to pin a
            // route already sees what this one established.
            routing.resolved(value);
            return value;
          } finally {
            pendingRoute = undefined;
          }
        }),
      ...(options.coordinator ? { coordinator: options.coordinator } : {}),
      ...(options.routeStore ? { routeStore: options.routeStore } : {}),
      ...(options.dependencies?.createRuntime
        ? { createRuntime: options.dependencies.createRuntime }
        : {}),
    },
  );
}

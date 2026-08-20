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

import type { Operation } from "effection";
import { useAcpxProvider } from "@executablemd/acp";
import type {
  AcpxProvider,
  AcpxProviderDependencies,
  SessionRouteContext,
} from "@executablemd/acp";
import type { NativeAdapter } from "@executablemd/acp";
import { useRouteSlot } from "./route-slot.ts";
import type { AcpAgentRegistry, AcpSessionRecord, AcpSessionStore } from "acpx/runtime";

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

export interface TestAgentProviderOptions {
  defaultAgent: string;
  agents: string[];
  workerCommand: string[];
  probeRoute: string;
  /** Map a routing context to the scenario route pinned for its work. */
  resolveRoute(context: SessionRouteContext): string;
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

export const TEST_AGENT_NATIVE_ADAPTER: NativeAdapter = {
  launcher: TEST_AGENT_LAUNCHER,
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
        options.agents.map((name) => [name, TEST_AGENT_NATIVE_ADAPTER]),
      ),
      // withSlot bounds the route mutex to the hook's op without a scope
      // of its own — op's acquisitions (turn resources) belong to the
      // provider's subscriber scope and outlive the critical section.
      withSessionRoute: (context, op) =>
        routeSlot.withSlot(function* () {
          pendingRoute = options.resolveRoute(context);
          try {
            return yield* op();
          } finally {
            pendingRoute = undefined;
          }
        }),
      ...(options.dependencies?.createRuntime
        ? { createRuntime: options.dependencies.createRuntime }
        : {}),
    },
  );
}

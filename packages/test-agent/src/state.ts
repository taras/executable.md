/**
 * Per-boundary ACPX state for `<TestAgent>` (specs/test-agent-spec.md
 * §Scenario instances): the production provider state composed with an
 * in-memory session store and a dynamic registry whose resolve() embeds
 * the pending instance route into the worker command. Routing flows
 * through the provider's `withSessionRoute` hook: the route slot is
 * held only across the provider's registry-dependent work (preparation
 * and ensure/session validation + turn start), released while the
 * provider waits on the per-session queue and during turn consumption.
 */

import type { Operation } from "effection";
import { useAcpxProvider } from "@executablemd/acp";
import type {
  AcpxProvider,
  AcpxProviderDependencies,
  SessionRouteContext,
} from "@executablemd/acp";
import { useRouteSlot } from "./route-slot.ts";
import type { AcpAgentRegistry, AcpSessionRecord, AcpSessionStore } from "acpx/runtime";

export interface TestAgentAcpx {
  state: AcpxProvider;
}

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

export interface TestAgentAcpxOptions {
  defaultAgent: string;
  agents: string[];
  workerCommand: string[];
  probeRoute: string;
  /** Map a routing context to the instance route pinned for its work. */
  routeFor(context: SessionRouteContext): string;
  dependencies?: AcpxProviderDependencies;
}

export function* useTestAgentAcpx(options: TestAgentAcpxOptions): Operation<TestAgentAcpx> {
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

  const state = yield* useAcpxProvider(
    { defaultAgent: options.defaultAgent, permissionMode: "deny-all" },
    {
      sessionStore: createMemorySessionStore(),
      agentRegistry: registry,
      // withSlot bounds the route mutex to the seam's op without a scope
      // of its own — op's acquisitions (turn resources) belong to the
      // provider's subscriber scope and outlive the critical section.
      withSessionRoute: (context, op) =>
        routeSlot.withSlot(function* () {
          pendingRoute = options.routeFor(context);
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

  return { state };
}

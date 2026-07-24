/**
 * Per-boundary ACPX state for `<TestAgent>` (specs/test-agent-spec.md
 * §Scenario instances): the production provider state composed with an
 * in-memory session store and a dynamic registry whose resolve() embeds
 * the pending instance route into the worker command. The route slot is
 * guarded by a FIFO mutex held only across session resolution and turn
 * start — never across turn consumption — so different sessions stay
 * concurrent while every registry lookup sees the right route.
 */

import { withResolvers } from "effection";
import type { Operation } from "effection";
import { useAcpxProviderState } from "@executablemd/acp";
import type { AcpxProviderSeams, AcpxProviderState } from "@executablemd/acp";
import type { AcpAgentRegistry, AcpSessionRecord, AcpSessionStore } from "acpx/runtime";

export interface TestAgentAcpx {
  state: AcpxProviderState;
  /**
   * Serialize an operation under the route mutex with the registry
   * routed to `route`. The slot clears and the mutex releases when the
   * operation returns.
   */
  withRoute<T>(route: string, op: () => Operation<T>): Operation<T>;
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
  seams?: AcpxProviderSeams;
}

export function* useTestAgentAcpx(options: TestAgentAcpxOptions): Operation<TestAgentAcpx> {
  let pendingRoute: string | undefined;
  let tail: Operation<void> | undefined;

  const registry: AcpAgentRegistry = {
    resolve() {
      const route = pendingRoute ?? options.probeRoute;
      return [...options.workerCommand, "--connect", route].join(" ");
    },
    list() {
      return options.agents;
    },
  };

  const state = yield* useAcpxProviderState(
    { defaultAgent: options.defaultAgent, permissionMode: "deny-all" },
    {
      sessionStore: createMemorySessionStore(),
      agentRegistry: registry,
      ...(options.seams?.createRuntime ? { createRuntime: options.seams.createRuntime } : {}),
    },
  );

  function* withRoute<T>(route: string, op: () => Operation<T>): Operation<T> {
    const predecessor = tail;
    const mine = withResolvers<void>();
    tail = mine.operation;
    if (predecessor) {
      yield* predecessor;
    }
    pendingRoute = route;
    try {
      return yield* op();
    } finally {
      pendingRoute = undefined;
      mine.resolve();
    }
  }

  return { state, withRoute };
}

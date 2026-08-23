/**
 * Tier TS — per-boundary ACPX state tests (specs/test-agent-spec.md
 * §Scenario instances): withSessionRoute pins the pending route for the
 * provider's registry-dependent work and releases it otherwise.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/core";
import type { SessionRouteContext } from "@executablemd/acp";
import { useTestAgentProvider } from "../src/provider.ts";
import { createDeterministicSessionCoordinator } from "../src/session-coordinator.ts";
import { createMemorySessionRouteStore } from "@executablemd/acp";
import { deriveSessionKey } from "../../acp/src/session-key.ts";
import { createFakeRuntime, useFlatWorld } from "../../acp/tests/helpers.ts";

const INST = "127.0.0.1:1/tok/inst-1";
const PROBE = "127.0.0.1:1/tok/probe";

function* drainPrompt(): Operation<void> {
  const stream = yield* Agent.operations.prompt("go");
  const subscription = yield* stream;
  let next = yield* subscription.next();
  while (!next.done) {
    next = yield* subscription.next();
  }
}

describe("Tier TS — test-agent ACPX state", () => {
  it("TS1: withSessionRoute pins the instance route for provider work; probe route otherwise", function* () {
    const harness = createFakeRuntime();
    yield* useFlatWorld("/work");
    const provider = yield* useTestAgentProvider({
      defaultAgent: "test",
      agents: ["test"],
      workerCommand: ["xmd", "test-agent"],
      probeRoute: PROBE,
      // deno-lint-ignore require-yield
      *routeFor(_context: SessionRouteContext) {
        return { route: INST, resolved: () => {} };
      },
      // The test agent advertises native launch, so every session and prompt
      // it serves takes ownership first. This partition owns its own.
      coordinator: createDeterministicSessionCoordinator(),
      routeStore: createMemorySessionRouteStore(),
      dependencies: { createRuntime: harness.create },
    });
    yield* Agent.around(
      {
        *agent([name], _next) {
          return yield* provider.agent(name);
        },
        *prompt([content, options], _next) {
          return provider.promptStream(content, options);
        },
      },
      { at: "min" },
    );

    // During a prompt the ensure sees the pinned instance route: the
    // session key derives from the routed worker command, not the probe
    // one. (The runtime is created lazily on first use.)
    yield* drainPrompt();
    const registry = harness.createdOptions[0]!.agentRegistry;
    expect(harness.ensureCalls[0]!.sessionKey).toBe(
      deriveSessionKey(`xmd test-agent --connect ${INST}`, "/work"),
    );
    expect(harness.ensureCalls[0]!.sessionKey).not.toBe(
      deriveSessionKey(`xmd test-agent --connect ${PROBE}`, "/work"),
    );
    // Outside the seam the route is released — the registry falls
    // back to the probe route.
    expect(registry.resolve("test")).toBe(`xmd test-agent --connect ${PROBE}`);
  });

  it("TS2: withSessionRoute is a bounded critical section, not held across turn consumption", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* useFlatWorld("/work");
    const routes: string[] = [];
    const provider = yield* useTestAgentProvider({
      defaultAgent: "test",
      agents: ["test"],
      workerCommand: ["xmd", "test-agent"],
      probeRoute: PROBE,
      // deno-lint-ignore require-yield
      *routeFor(context: SessionRouteContext) {
        routes.push(String(context.session ?? "default"));
        return { route: INST, resolved: () => {} };
      },
      coordinator: createDeterministicSessionCoordinator(),
      routeStore: createMemorySessionRouteStore(),
      dependencies: { createRuntime: harness.create },
    });
    yield* Agent.around(
      {
        *agent([name], _next) {
          return yield* provider.agent(name);
        },
        *prompt([content, options], _next) {
          return provider.promptStream(content, options);
        },
      },
      { at: "min" },
    );

    const task = yield* spawn(() => drainPrompt());
    yield* sleep(10);
    // The turn has started (withSessionRoute entered twice: prepare +
    // ensure/start) and is now consuming — the route slot is free,
    // so the registry reads the probe fallback again.
    expect(routes.length).toBe(2);
    expect(harness.createdOptions[0]!.agentRegistry.resolve("test")).toBe(
      `xmd test-agent --connect ${PROBE}`,
    );

    harness.turns[0]!.finish([{ type: "text_delta", text: "ok", stream: "output" }], {
      status: "completed",
      stopReason: "end_turn",
    });
    yield* task;
  });
});

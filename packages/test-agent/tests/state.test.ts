/**
 * Tier TS — per-boundary ACPX state tests (specs/test-agent-spec.md
 * §Scenario instances): the route seam pins the pending route for the
 * provider's registry-dependent work and releases it otherwise.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/core";
import type { SessionRoutingContext } from "@executablemd/acp";
import { useTestAgentAcpx } from "../src/state.ts";
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
  it("TS1: the route seam pins the instance route for provider work; probe route otherwise", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld("/work");
      const routeFor = (_context: SessionRoutingContext) => INST;
      const acpx = yield* useTestAgentAcpx({
        defaultAgent: "test",
        agents: ["test"],
        workerCommand: ["xmd", "test-agent"],
        probeRoute: PROBE,
        routeFor,
        seams: { createRuntime: harness.create },
      });
      yield* Agent.around(
        {
          *agent([name], _next) {
            return yield* acpx.state.agent(name);
          },
          // deno-lint-ignore require-yield
          *prompt([content, options], _next) {
            return acpx.state.promptStream(content, options);
          },
        },
        { at: "min" },
      );

      // During a prompt the ensure sees the pinned instance route: the
      // session key derives from the routed worker command. (The runtime
      // is created lazily on first use.)
      yield* drainPrompt();
      const registry = harness.createdOptions[0]!.agentRegistry;
      expect(harness.ensureCalls[0]!.sessionKey).toContain("xmd%20test-agent");
      // Outside the seam the route is released — the registry falls
      // back to the probe route.
      expect(registry.resolve("test")).toBe(`xmd test-agent --connect ${PROBE}`);
    });
  });

  it("TS2: the route seam is a bounded critical section, not held across turn consumption", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* useFlatWorld("/work");
      const routes: string[] = [];
      const acpx = yield* useTestAgentAcpx({
        defaultAgent: "test",
        agents: ["test"],
        workerCommand: ["xmd", "test-agent"],
        probeRoute: PROBE,
        routeFor: (context: SessionRoutingContext) => {
          routes.push(String(context.session ?? "default"));
          return INST;
        },
        seams: { createRuntime: harness.create },
      });
      yield* Agent.around(
        {
          *agent([name], _next) {
            return yield* acpx.state.agent(name);
          },
          // deno-lint-ignore require-yield
          *prompt([content, options], _next) {
            return acpx.state.promptStream(content, options);
          },
        },
        { at: "min" },
      );

      const task = yield* spawn(() => drainPrompt());
      yield* sleep(10);
      // The turn has started (route seam entered twice: prepare +
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
});

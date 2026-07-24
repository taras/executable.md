/**
 * Tier TS — per-boundary ACPX state tests (specs/test-agent-spec.md
 * §Scenario instances): pending-route registry behavior and FIFO route
 * serialization.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn } from "effection";
import { useTestAgentAcpx } from "../src/state.ts";
import { createFakeRuntime, useFlatWorld } from "../../acp/tests/helpers.ts";

describe("Tier TS — test-agent ACPX state", () => {
  it("TS1: registry lookups see the pending route and fall back to the probe route", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld("/work");
      const acpx = yield* useTestAgentAcpx({
        defaultAgent: "test",
        agents: ["test"],
        workerCommand: ["xmd", "test-agent"],
        probeRoute: "127.0.0.1:1/tok/probe",
        seams: { createRuntime: harness.create },
      });
      expect(yield* acpx.state.agent("test")).toBe("test");
      const registry = harness.createdOptions[0]!.agentRegistry;
      expect(registry.resolve("test")).toBe("xmd test-agent --connect 127.0.0.1:1/tok/probe");
      yield* acpx.withRoute("127.0.0.1:1/tok/inst-1", function* () {
        expect(registry.resolve("test")).toBe("xmd test-agent --connect 127.0.0.1:1/tok/inst-1");
      });
      expect(registry.resolve("test")).toBe("xmd test-agent --connect 127.0.0.1:1/tok/probe");
    });
  });

  it("TS2: withRoute serializes FIFO so concurrent lookups never mix routes", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld("/work");
      const acpx = yield* useTestAgentAcpx({
        defaultAgent: "test",
        agents: ["test"],
        workerCommand: ["xmd", "test-agent"],
        probeRoute: "127.0.0.1:1/tok/probe",
        seams: { createRuntime: harness.create },
      });
      const order: string[] = [];
      const first = yield* spawn(() =>
        acpx.withRoute("127.0.0.1:1/tok/a", function* () {
          order.push("a-start");
          yield* sleep(15);
          order.push("a-end");
        }),
      );
      const second = yield* spawn(() =>
        acpx.withRoute("127.0.0.1:1/tok/b", function* () {
          order.push("b");
        }),
      );
      yield* first;
      yield* second;
      expect(order).toEqual(["a-start", "a-end", "b"]);
    });
  });
});

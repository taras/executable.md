/**
 * Tier TS — per-boundary ACPX state tests (specs/test-agent-spec.md
 * §Scenario instances): withSessionRoute pins the pending route for the
 * provider's registry-dependent work and releases it otherwise.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, withResolvers, useScope, until } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/core";
import { createAcpRuntime } from "@executablemd/acp";
import type { AcpRuntimeHandle, AcpRuntimeOptions, SessionRouteContext } from "@executablemd/acp";
import { tmpdir } from "node:os";
import { cliBase } from "@executablemd/test-support/launch";
import { readAgentOptions } from "../../acp/src/session-configuration.ts";
import { configOptions } from "../src/configuration.ts";
import { useTestAgentController } from "../src/controller.ts";
import {
  TEST_AGENT_CLIENT_NATIVE,
  useTestAgentProvider,
  workerAgentCommand,
} from "../src/provider.ts";
import { createDeterministicSessionCoordinator } from "../src/session-coordinator.ts";
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
    const { provider } = yield* useTestAgentProvider({
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
    const { provider } = yield* useTestAgentProvider({
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

describe("inspection acquisition", () => {
  const INSPECTION = "127.0.0.1:1/tok/inspection";
  const workerCommand = ["xmd", "test-agent"];
  // deno-lint-ignore require-yield
  const routeFor = function* (_context: SessionRouteContext) {
    return { route: INST, resolved: () => {} };
  };
  const inspection = {
    agent: "test",
    refuseClose: false,
    // deno-lint-ignore require-yield
    *register() {
      return { route: INSPECTION };
    },
  };

  it("lets a named acquisition claim the slot while inspection readback waits", function* () {
    const harness = createFakeRuntime();
    const reading = withResolvers<void>();
    const finish = withResolvers<void>();
    const named = withResolvers<void>();
    harness.statusGate = (count) =>
      count === 1
        ? (function* () {
            reading.resolve();
            yield* finish.operation;
          })()
        : undefined;
    yield* useFlatWorld("/work");
    const { provider } = yield* useTestAgentProvider({
      defaultAgent: "test",
      agents: ["test"],
      workerCommand,
      probeRoute: PROBE,
      *routeFor(context) {
        named.resolve();
        return yield* routeFor(context);
      },
      inspection,
      coordinator: createDeterministicSessionCoordinator(),
      dependencies: { createRuntime: harness.create },
    });
    yield* Agent.around(
      {
        *agent([name]) {
          return yield* provider.agent(name);
        },
      },
      { at: "min" },
    );
    const inspecting = yield* spawn(() => provider.options());
    yield* reading.operation;
    const prompting = yield* spawn(function* () {
      const subscription = yield* provider.promptStream("go", { session: "named" });
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });
    yield* named.operation;
    finish.resolve();
    yield* inspecting;
    yield* prompting;
    expect(harness.turns.length).toBe(1);
    expect(harness.ensureCalls.length).toBe(2);
  });

  it("checks availability before acquiring a temporary session for the client-native agent", function* () {
    const agent = TEST_AGENT_CLIENT_NATIVE;
    const harness = createFakeRuntime();
    const probeCommands: (string | string[])[] = [];
    harness.doctorReports.push(
      { ok: false, message: "availability deliberately refused" },
      { ok: true, message: "available" },
    );
    yield* useFlatWorld("/work");
    const { provider } = yield* useTestAgentProvider({
      defaultAgent: agent,
      agents: [agent],
      workerCommand,
      probeRoute: PROBE,
      // deno-lint-ignore require-yield
      *routeFor() {
        throw new Error("inspection used a named route");
      },
      inspection: { ...inspection, agent },
      dependencies: {
        createRuntime(options) {
          const runtime = harness.create(options);
          if (options.probeAgent === undefined) {
            return runtime;
          }
          return {
            ...runtime,
            doctor() {
              probeCommands.push(options.agentRegistry.resolve(agent));
              return runtime.doctor();
            },
          };
        },
      },
    });

    expect(yield* provider.agent(agent)).toBe(agent);
    expect(harness.doctorCalls).toBe(0);

    let failure: unknown;
    try {
      yield* provider.options(agent);
    } catch (error) {
      failure = error;
    }
    const probeCommand = workerAgentCommand(workerCommand, PROBE);
    expect(String(failure)).toContain("availability deliberately refused");
    expect(probeCommands).toEqual([probeCommand]);
    expect(harness.ensureCalls).toEqual([]);
    expect(harness.closeCalls).toEqual([]);
    expect(harness.turns).toEqual([]);

    harness.activity = (activity) => {
      if (activity === "ensure") {
        expect(harness.doctorCalls).toBe(2);
      }
    };
    expect((yield* provider.options(agent)).agent).toBe(agent);
    expect(probeCommands).toEqual([probeCommand, probeCommand]);
    expect(harness.ensureCalls.length).toBe(1);
    expect(harness.ensureCalls[0].sessionKey.startsWith("xmd:inspect:")).toBe(true);
    expect(harness.closeCalls.map(({ sessionKey }) => sessionKey)).toEqual([
      harness.ensureCalls[0].sessionKey,
    ]);
    expect(harness.turns).toEqual([]);
  });

  it("binds the disposable probe independently and joins its pending cleanup on halt", function* () {
    const agent = TEST_AGENT_CLIENT_NATIVE;
    const harness = createFakeRuntime();
    const probing = withResolvers<void>();
    const lookup = withResolvers<void>();
    const closing = withResolvers<void>();
    const release = withResolvers<void>();
    const cleanup = withResolvers<void>();
    const waiter = withResolvers<void>();
    const attempted = withResolvers<void>();
    let command: string | string[] | undefined;
    let haltFinished = false;
    yield* useFlatWorld("/work");
    yield* scoped(function* () {
      const scope = yield* useScope();
      const { provider, dependencies } = yield* useTestAgentProvider({
        defaultAgent: agent,
        agents: [agent],
        workerCommand,
        probeRoute: PROBE,
        routeFor,
        inspection: { ...inspection, agent },
        dependencies: {
          createRuntime(options) {
            const runtime = harness.create(options);
            if (options.probeAgent === undefined) {
              return runtime;
            }
            return {
              ...runtime,
              doctor() {
                probing.resolve();
                return scope.run(function* () {
                  yield* lookup.operation;
                  command = options.agentRegistry.resolve(agent);
                  const report = yield* until(runtime.doctor());
                  closing.resolve();
                  yield* cleanup.operation;
                  return report;
                });
              },
            };
          },
        },
      });
      const hook = dependencies.withSessionRoute;
      if (hook === undefined) {
        throw new Error("missing route hook");
      }
      const inspecting = yield* spawn(() => provider.options());
      yield* probing.operation;
      const competing = yield* spawn(function* () {
        attempted.resolve();
        yield* hook({ agentName: agent, session: "named", cwd: "/work" }, function* () {
          waiter.resolve();
          yield* release.operation;
        });
      });
      yield* attempted.operation;
      const halting = yield* spawn(function* () {
        yield* inspecting.halt();
        haltFinished = true;
      });
      expect(haltFinished).toBe(false);
      expect(dependencies.agentRegistry?.resolve(agent)).toBe(
        workerAgentCommand(workerCommand, INSPECTION),
      );
      lookup.resolve();
      yield* closing.operation;
      expect(haltFinished).toBe(false);
      expect(dependencies.agentRegistry?.resolve(agent)).toBe(
        workerAgentCommand(workerCommand, INSPECTION),
      );
      cleanup.resolve();
      release.resolve();
      yield* halting;
      yield* waiter.operation;
      yield* competing;
    });
    expect(command).toBe(workerAgentCommand(workerCommand, PROBE));
    expect(harness.ensureCalls).toEqual([]);
  });

  it("refuses another agent before probing or registering a worker", function* () {
    const harness = createFakeRuntime();
    yield* useFlatWorld("/work");
    const { provider } = yield* useTestAgentProvider({
      defaultAgent: "other",
      agents: ["test", "other"],
      workerCommand,
      probeRoute: PROBE,
      routeFor,
      inspection: {
        ...inspection,
        // deno-lint-ignore require-yield
        *register() {
          throw new Error("registered the wrong agent");
        },
      },
      dependencies: { createRuntime: harness.create },
    });
    let failure: unknown;
    try {
      yield* provider.options();
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain('configured for "test", not "other"');
    expect(harness.createdOptions).toEqual([]);
    expect(harness.ensureCalls).toEqual([]);
  });
});

describe("real inspection lifecycle", { sanitizeOps: false, sanitizeResources: false }, () => {
  const cases: { name: string; refuse?: "open" | "close" }[] = [
    { name: "joins ordinary inspection release and worker exit on success" },
    { name: "joins worker exit after session/new refuses inspection", refuse: "open" },
    {
      name: "joins real inspection release, worker exit and retry before reporting close refusal",
      refuse: "close",
    },
  ];
  for (const { name, refuse } of cases) {
    it(name, function* () {
      const models = {
        selected: "small",
        options: [
          { id: "small", efforts: { selected: "low", options: ["low"] } },
          { id: "sol", efforts: { selected: "medium", options: ["medium", "high"] } },
        ],
      };
      type WireMessage = Parameters<NonNullable<AcpRuntimeOptions["onAcpMessage"]>>[1];
      type Lifecycle = NonNullable<AcpRuntimeOptions["processLifecycle"]>;
      type Started = Parameters<NonNullable<Lifecycle["onSpawned"]>>[0];
      type Exited = Parameters<NonNullable<Lifecycle["onExit"]>>[0];
      const requests: WireMessage[] = [];
      const replies: WireMessage[] = [];
      const starts: Started[] = [];
      const exits: Exited[] = [];
      const statusReads: {
        handle: AcpRuntimeHandle;
        options: ReturnType<typeof readAgentOptions>;
      }[] = [];
      const closes: {
        handle: AcpRuntimeHandle;
        reason: string;
        discardPersistentState?: boolean;
      }[] = [];
      const finishedCloses: AcpRuntimeHandle[] = [];
      const handles: AcpRuntimeHandle[] = [];
      const attemptedKeys: string[] = [];
      const order: string[] = [];
      let namedRoutes = 0;
      yield* useFlatWorld(tmpdir());

      let failure: unknown;
      try {
        yield* scoped(function* () {
          const controller = yield* useTestAgentController();
          const { provider } = yield* useTestAgentProvider({
            defaultAgent: "codex",
            agents: ["codex"],
            workerCommand: [...cliBase(), "test-agent"],
            probeRoute: controller.probeRoute,
            // deno-lint-ignore require-yield
            *routeFor() {
              namedRoutes++;
              throw new Error("inspection used a named route");
            },
            inspection: {
              agent: "codex",
              refuseClose: refuse === "close",
              register: () => controller.useInspection({ models, refuse }),
            },
            dependencies: {
              createRuntime(options) {
                const runtime = createAcpRuntime({
                  ...options,
                  onAcpMessage(direction, message) {
                    (direction === "outbound" ? requests : replies).push(message);
                  },
                  processLifecycle: {
                    onSpawned(start) {
                      starts.push(start);
                    },
                    onExit(exit) {
                      exits.push(exit);
                    },
                  },
                });
                if (options.probeAgent !== undefined) {
                  return runtime;
                }
                const ensureSession = runtime.ensureSession.bind(runtime);
                const getStatus = runtime.getStatus.bind(runtime);
                const close = runtime.close.bind(runtime);
                return Object.assign(runtime, {
                  ensureSession(input: Parameters<typeof ensureSession>[0]) {
                    attemptedKeys.push(input.sessionKey);
                    return ensureSession(input).then((handle) => {
                      handles.push(handle);
                      return handle;
                    });
                  },
                  getStatus(input: Parameters<typeof getStatus>[0]) {
                    return getStatus(input).then((status) => {
                      order.push("status");
                      statusReads.push({ handle: input.handle, options: readAgentOptions(status) });
                      return status;
                    });
                  },
                  close(input: Parameters<typeof close>[0]) {
                    order.push("close");
                    closes.push(input);
                    return close(input).then(() => {
                      finishedCloses.push(input.handle);
                      order.push("released");
                    });
                  },
                });
              },
            },
          });

          const choices = yield* provider.options("codex", { model: "sol" });
          expect(choices.agent).toBe("codex");
          expect(choices.model?.selected).toBe("sol");
          expect(choices.model?.options.map(({ id }) => id)).toEqual(["small", "sol"]);
          expect(choices.effort?.selected).toBe("medium");
          expect(choices.effort?.options.map(({ id }) => id)).toEqual(["medium", "high"]);
          order.push("returned");
          expect(finishedCloses.length).toBe(1);
        });
      } catch (error) {
        failure = error;
      }

      expect(namedRoutes).toBe(0);
      expect(attemptedKeys.length).toBe(1);
      const [sessionKey] = attemptedKeys;
      expect(sessionKey.startsWith("xmd:inspect:")).toBe(true);
      expect(starts.map(({ scope }) => scope)).toEqual([
        { kind: "runtime-probe", agent: "codex" },
        { kind: "runtime-session", sessionKey },
      ]);
      expect(exits.map(({ launchId, pid }) => ({ launchId, pid }))).toEqual(
        starts.map(({ launchId, pid }) => ({ launchId, pid })),
      );

      const calls = requests.flatMap((message) =>
        "method" in message && "id" in message ? [message] : [],
      );
      expect(calls.map(({ method }) => method)).toEqual(
        refuse === "open"
          ? ["initialize", "session/new"]
          : ["initialize", "session/new", "session/set_config_option"],
      );
      const responses = calls.map(({ id }) =>
        replies.find((message) => "id" in message && message.id === id),
      );
      expect(responses[0]).toMatchObject({ result: { protocolVersion: 1 } });

      if (refuse === "open") {
        expect(String(failure)).toContain("TestAgent inspection refused to open.");
        expect(responses[1]).toMatchObject({
          error: { message: "TestAgent inspection refused to open." },
        });
        expect(handles).toEqual([]);
        expect(order).toEqual([]);
        return;
      }

      if (refuse === "close") {
        expect(String(failure)).toContain("TestAgent inspection refused to close.");
      } else {
        expect(failure).toBe(undefined);
      }
      expect(order).toEqual([
        "status",
        "status",
        "close",
        "released",
        "returned",
        ...(refuse === "close" ? ["close", "released"] : []),
      ]);
      expect(handles.length).toBe(1);
      const handle = handles[0];
      expect(handle.sessionKey).toBe(sessionKey);
      expect(statusReads.every((read) => read.handle === handle)).toBe(true);
      expect(statusReads[0].options.model?.set.selected).toBe("small");
      expect(statusReads[1].options.model?.set.selected).toBe("sol");
      expect(statusReads[1].options.effort?.set.selected).toBe("medium");
      expect(statusReads[1].options.effort?.set.options.map(({ id }) => id)).toEqual([
        "medium",
        "high",
      ]);
      expect(closes.map(({ reason }) => reason)).toEqual([
        "agent options inspected",
        ...(refuse === "close" ? ["scope teardown"] : []),
      ]);
      expect(
        closes.every(
          (close) => close.handle === handle && close.discardPersistentState === undefined,
        ),
      ).toBe(true);
      expect(finishedCloses.every((closed) => closed === handle)).toBe(true);

      expect(responses[1]).toMatchObject({
        result: { sessionId: handle.backendSessionId, configOptions: configOptions(models) },
      });
      expect(calls[2]).toMatchObject({
        params: { sessionId: handle.backendSessionId, configId: "model", value: "sol" },
      });
      expect(responses[2]).toMatchObject({
        result: { configOptions: configOptions({ ...models, selected: "sol" }) },
      });
    });
  }
});

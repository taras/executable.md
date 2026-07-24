/**
 * The `<TestAgent>` vocabulary (specs/test-agent-spec.md §TestAgent).
 *
 * `installTestAgentVocabulary` must be installed BEFORE
 * `installAgentVocabulary` in the same scope: in-scope middleware runs
 * in install order, so the global `<Prompt>` interceptor here sees the
 * invocation first, forces `throwOnError` only when both `<TestAgent>`
 * and `<Test>` are active, and otherwise delegates unchanged.
 *
 * Each `<Test>` receives fresh ACPX state keyed by its lease EvalScope;
 * the state is provisioned by a suspended task spawned into that scope,
 * so halting the lease tears the provider down (canceling turns and
 * closing workers) and removes the map entry on normal and failure
 * paths alike. Outside a `<Test>`, the `<TestAgent>` scope itself is
 * the isolation boundary.
 */

import { createContext, ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { EvalScope } from "@effectionx/scope-eval";
import { Agent, Component, evalScope } from "@executablemd/core";
import type { ComponentInvocation, InvocationContext, Segment } from "@executablemd/core";
import type { SessionRoutingContext } from "@executablemd/acp";
import { cwd as contextualCwd, readTextFile } from "@executablemd/runtime";
import { Test } from "@executablemd/testing";
import { useTestAgentController } from "./controller.ts";
import type { ScenarioInstance, TestAgentController } from "./controller.ts";
import { useTestAgentAcpx } from "./state.ts";
import type { TestAgentAcpx } from "./state.ts";

export interface TestAgentVocabularyOptions {
  /** Command segments that relaunch this xmd as `test-agent`. */
  workerCommand: string[];
}

interface Scenario {
  agent: string;
  sessionName: string;
  scenarioDir: string;
  doc: { path: string; source: string };
  duplicate: boolean;
}

interface BoundaryState {
  acpx: TestAgentAcpx;
  instances: Map<string, ScenarioInstance>;
  bySessionKey: Map<string, ScenarioInstance>;
  resolveInstanceSync(
    instances: Map<string, ScenarioInstance>,
    agentName: string,
    sessionName: string | undefined,
    dir: string,
  ): ScenarioInstance;
}

interface TestAgentSession {
  defaultAgent: string;
  controller: TestAgentController;
  scenarios: Map<string, Scenario>;
  boundary(): Operation<BoundaryState>;
}

const TestAgentCtx = createContext<TestAgentSession | undefined>("testAgent.session", undefined);

function configError(source: string, message: string): Segment {
  return { type: "error", message: `<${source}> ${message}`, source };
}

function scenarioKey(agent: string, sessionName: string): string {
  // JSON encoding keeps the key textual and collision-safe for any
  // agent/session values.
  return JSON.stringify([agent, sessionName]);
}

export function* installTestAgentVocabulary(options: TestAgentVocabularyOptions): Operation<void> {
  function* expandTestAgent(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    if (!(yield* Test.operations.sessionActive)) {
      return [
        configError(
          "TestAgent",
          "is valid only in an active testing session created by xmd test or useTesting().",
        ),
      ];
    }
    const agentProp = invocation.props.agent;
    if (agentProp !== undefined && typeof agentProp !== "string") {
      return [configError("TestAgent", 'the "agent" prop must be a string literal.')];
    }
    const defaultAgent = typeof agentProp === "string" ? agentProp : "test";

    return yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const scenarios = new Map<string, Scenario>();
      const boundaries = new Map<EvalScope | "test-agent-scope", BoundaryState>();

      // Sync scenario→instance resolution keyed by (agent, session,
      // cwd). The cwd is supplied by the caller (the seam context)
      // rather than read again from the runtime.
      function resolveInstanceSync(
        instances: Map<string, ScenarioInstance>,
        agentName: string,
        sessionName: string | undefined,
        dir: string,
      ): ScenarioInstance {
        const key = scenarioKey(agentName, sessionName ?? "");
        const scenario = scenarios.get(key);
        if (!scenario) {
          throw new Error(
            `no <TestAgent.Scenario> maps agent "${agentName}" and session ` +
              `"${sessionName ?? "(default)"}"`,
          );
        }
        if (scenario.duplicate) {
          throw new Error(
            `duplicate <TestAgent.Scenario> mappings for agent "${agentName}" and session ` +
              `"${sessionName ?? "(default)"}"`,
          );
        }
        const instanceKey = JSON.stringify([key, dir]);
        const existing = instances.get(instanceKey);
        if (existing) {
          return existing;
        }
        const instance = controller.registerInstance({
          doc: scenario.doc,
          scenarioDir: scenario.scenarioDir,
        });
        instances.set(instanceKey, instance);
        return instance;
      }

      function* provisionState(): Operation<BoundaryState> {
        // The maps exist before useTestAgentAcpx so the route resolver
        // can close over them.
        const instances = new Map<string, ScenarioInstance>();
        const bySessionKey = new Map<string, ScenarioInstance>();
        const routeFor = (context: SessionRoutingContext): string => {
          if (typeof context.session === "object") {
            const instance = bySessionKey.get(context.session.sessionKey);
            if (!instance) {
              throw new Error(`unknown or stale agent session "${context.session.sessionKey}"`);
            }
            return instance.route;
          }
          return resolveInstanceSync(instances, context.agentName, context.session, context.cwd)
            .route;
        };
        const acpx = yield* useTestAgentAcpx({
          defaultAgent,
          agents: [defaultAgent],
          workerCommand: options.workerCommand,
          probeRoute: controller.probeRoute,
          routeFor,
        });
        return { acpx, instances, bySessionKey, resolveInstanceSync };
      }

      // The <TestAgent> scope itself is the fallback isolation boundary.
      const fallback = yield* provisionState();
      boundaries.set("test-agent-scope", fallback);
      yield* ensure(() => {
        for (const instance of fallback.instances.values()) {
          controller.unregisterInstance(instance.id);
        }
      });

      function* boundary(): Operation<BoundaryState> {
        const within = yield* Test.operations.inTest;
        const lease = yield* evalScope;
        const key = within && lease ? lease : "test-agent-scope";
        const existing = boundaries.get(key);
        if (existing) {
          return existing;
        }
        if (key === "test-agent-scope") {
          return fallback;
        }
        const published = withResolvers<BoundaryState>();
        yield* key.eval(function* () {
          return yield* spawn(function* () {
            try {
              const state = yield* provisionState();
              boundaries.set(key, state);
              published.resolve(state);
              yield* suspend();
            } catch (error) {
              published.reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
              const state = boundaries.get(key);
              boundaries.delete(key);
              if (state) {
                for (const instance of state.instances.values()) {
                  controller.unregisterInstance(instance.id);
                }
              }
            }
          });
        });
        return yield* published.operation;
      }

      const session: TestAgentSession = { defaultAgent, controller, scenarios, boundary };
      yield* TestAgentCtx.set(session);

      yield* Agent.around(
        {
          *agent([name], _next) {
            const state = yield* boundary();
            return yield* state.acpx.state.agent(name);
          },
          *session([name], _next) {
            const state = yield* boundary();
            const agentName = yield* Agent.operations.agent();
            const dir = resolve(yield* contextualCwd());
            const instance = state.resolveInstanceSync(state.instances, agentName, name, dir);
            // The provider's session() drives the route seam itself;
            // it maps this same context back to the instance route.
            const resolved = yield* state.acpx.state.session(name);
            state.bySessionKey.set(resolved.sessionKey, instance);
            return resolved;
          },
          // deno-lint-ignore require-yield
          *prompt([content, promptOptions], _next) {
            // All routing flows through the provider's sessionRouting
            // seam; the boundary only selects the right acpx state.
            return {
              *[Symbol.iterator]() {
                const state = yield* boundary();
                const stream = state.acpx.state.promptStream(content, promptOptions);
                return yield* stream;
              },
            };
          },
        },
        { at: "min" },
      );

      const segments = yield* ctx.expand(invocation.children);
      return segments;
    });
  }

  function* expandScenario(invocation: ComponentInvocation): Operation<Segment[]> {
    const session = yield* TestAgentCtx.expect();
    if (session === undefined) {
      return [configError("TestAgent.Scenario", "is valid only inside <TestAgent>.")];
    }
    const { agent, session: sessionProp, src } = invocation.props;
    if (typeof src !== "string" || src.length === 0) {
      return [configError("TestAgent.Scenario", 'requires a "src" prop.')];
    }
    if (agent !== undefined && typeof agent !== "string") {
      return [configError("TestAgent.Scenario", 'the "agent" prop must be a string literal.')];
    }
    if (sessionProp !== undefined && typeof sessionProp !== "string") {
      return [configError("TestAgent.Scenario", 'the "session" prop must be a string literal.')];
    }

    const declaredIn = invocation.position?.path;
    const baseDir = declaredIn ? dirname(declaredIn) : ".";
    const srcPath = isAbsolute(src) ? src : resolve(baseDir, src);
    const source = yield* readTextFile(srcPath);

    const agentName = typeof agent === "string" ? agent : session.defaultAgent;
    const key = scenarioKey(agentName, typeof sessionProp === "string" ? sessionProp : "");
    const existing = session.scenarios.get(key);
    if (existing) {
      existing.duplicate = true;
      return [];
    }
    session.scenarios.set(key, {
      agent: agentName,
      sessionName: typeof sessionProp === "string" ? sessionProp : "",
      scenarioDir: dirname(srcPath),
      doc: { path: basename(srcPath), source },
      duplicate: false,
    });
    return [];
  }

  yield* Component.around({
    *expandInvocation([invocation, ctx], next) {
      if (invocation.name === "TestAgent") {
        return { segments: yield* expandTestAgent(invocation, ctx) };
      }
      if (invocation.name === "TestAgent.Scenario") {
        return { segments: yield* expandScenario(invocation) };
      }
      if (invocation.name === "Prompt") {
        const session = yield* TestAgentCtx.expect();
        if (
          session !== undefined &&
          (yield* Test.operations.inTest) &&
          invocation.props.throwOnError !== true
        ) {
          return yield* next(
            { ...invocation, props: { ...invocation.props, throwOnError: true } },
            ctx,
          );
        }
      }
      return yield* next(invocation, ctx);
    },
  });
}

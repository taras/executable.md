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
 *
 * Scenario instances are resources held by suspended tasks spawned into
 * their boundary scope, so a boundary halt releases them. Because
 * acquiring one is an operation but the provider's route resolver is a
 * synchronous callback, every instance is provisioned by the `session`
 * and `prompt` seams before the provider routes, and `routeFor` is a
 * pure lookup.
 */

import { createContext, scoped, spawn, suspend, useScope, withResolvers } from "effection";
import type { Operation, Scope } from "effection";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { EvalScope } from "@effectionx/scope-eval";
import { Agent, Component, evalScope } from "@executablemd/core";
import type { ComponentInvocation, InvocationContext, Segment, Session } from "@executablemd/core";
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

/** A resolved session, with the agent that created it. */
interface PinnedSession {
  agent: string;
  instance: ScenarioInstance;
}

interface BoundaryState {
  acpx: TestAgentAcpx;
  /** Owns every instance resource provisioned for this boundary. */
  boundaryScope: Scope;
  instances: Map<string, ScenarioInstance>;
  pending: Map<string, Operation<ScenarioInstance>>;
  bySessionKey: Map<string, PinnedSession>;
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

function instanceKeyFor(agent: string, sessionName: string | undefined, dir: string): string {
  return JSON.stringify([scenarioKey(agent, sessionName ?? ""), dir]);
}

function describeMapping(agentName: string, sessionName: string | undefined): string {
  return `agent "${agentName}" and session "${sessionName ?? "(default)"}"`;
}

/**
 * Resolve a pinned session for the agent using it. The registry routes
 * every agent through the same worker command, so the provider's own
 * ownership check cannot tell two agents apart — a session stays owned
 * by the agent that created it.
 */
function resolvePinned(
  bySessionKey: Map<string, PinnedSession>,
  sessionKey: string,
  agentName: string,
): PinnedSession {
  const pinned = bySessionKey.get(sessionKey);
  if (!pinned) {
    throw new Error(`unknown or stale agent session "${sessionKey}"`);
  }
  if (pinned.agent !== agentName) {
    throw new Error(
      `agent "${agentName}" does not match session "${sessionKey}" (agent "${pinned.agent}")`,
    );
  }
  return pinned;
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

      function* resolveInstance(
        state: BoundaryState,
        agentName: string,
        sessionName: string | undefined,
        dir: string,
      ): Operation<ScenarioInstance> {
        const scenario = scenarios.get(scenarioKey(agentName, sessionName ?? ""));
        if (!scenario) {
          throw new Error(
            `no <TestAgent.Scenario> maps ${describeMapping(agentName, sessionName)}`,
          );
        }
        if (scenario.duplicate) {
          throw new Error(
            `duplicate <TestAgent.Scenario> mappings for ${describeMapping(agentName, sessionName)}`,
          );
        }
        const key = instanceKeyFor(agentName, sessionName, dir);
        const existing = state.instances.get(key);
        if (existing) {
          return existing;
        }
        const inFlight = state.pending.get(key);
        if (inFlight) {
          return yield* inFlight;
        }
        // Publish the shared future before acquiring so concurrent
        // callers await this acquisition instead of starting their own.
        const ready = withResolvers<ScenarioInstance>();
        state.pending.set(key, ready.operation);
        yield* state.boundaryScope.spawn(function* () {
          let instance: ScenarioInstance;
          try {
            instance = yield* controller.useInstance({
              doc: scenario.doc,
              scenarioDir: scenario.scenarioDir,
            });
          } catch (error) {
            // Nothing consumes this task's failure yet, so it is
            // reported through the future the callers are waiting on.
            state.pending.delete(key);
            ready.reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          state.instances.set(key, instance);
          state.pending.delete(key);
          ready.resolve(instance);
          // Held, not caught: the future has settled, so a later
          // failure must reach the boundary scope to fail the test.
          yield* suspend();
        });
        return yield* ready.operation;
      }

      function* provisionState(): Operation<BoundaryState> {
        // The maps exist before useTestAgentAcpx so the route resolver
        // can close over them.
        const instances = new Map<string, ScenarioInstance>();
        const bySessionKey = new Map<string, PinnedSession>();
        const routeFor = (context: SessionRoutingContext): string => {
          if (typeof context.session === "object") {
            return resolvePinned(bySessionKey, context.session.sessionKey, context.agentName)
              .instance.route;
          }
          const instance = instances.get(
            instanceKeyFor(context.agentName, context.session, context.cwd),
          );
          if (!instance) {
            throw new Error(
              `no <TestAgent.Scenario> maps ${describeMapping(context.agentName, context.session)}`,
            );
          }
          return instance.route;
        };
        const acpx = yield* useTestAgentAcpx({
          defaultAgent,
          agents: [defaultAgent],
          workerCommand: options.workerCommand,
          probeRoute: controller.probeRoute,
          routeFor,
        });
        return {
          acpx,
          boundaryScope: yield* useScope(),
          instances,
          pending: new Map(),
          bySessionKey,
        };
      }

      // The <TestAgent> scope itself is the fallback isolation boundary.
      const fallback = yield* provisionState();
      boundaries.set("test-agent-scope", fallback);

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
              boundaries.delete(key);
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
            const instance = yield* resolveInstance(state, agentName, name, dir);
            // The provider's session() drives the route seam itself;
            // it maps this same context back to the instance route.
            const resolved = yield* state.acpx.state.session(name);
            state.bySessionKey.set(resolved.sessionKey, { agent: agentName, instance });
            return resolved;
          },
          *prompt([content, promptOptions], _next) {
            // Routing flows through the provider's sessionRouting seam,
            // whose resolver is synchronous — so the instance it will
            // look up is provisioned here, once the stream is subscribed.
            return {
              *[Symbol.iterator]() {
                const state = yield* boundary();
                const pinned: string | Session | undefined = promptOptions?.session;
                const agentName = yield* Agent.operations.agent(promptOptions?.agent);
                if (typeof pinned === "object") {
                  // Already provisioned by session(); resolving it again
                  // would mis-key it as the unnamed session.
                  resolvePinned(state.bySessionKey, pinned.sessionKey, agentName);
                } else {
                  const dir = resolve(yield* contextualCwd());
                  yield* resolveInstance(state, agentName, pinned, dir);
                }
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

/**
 * The `<TestAgent>` components (specs/test-agent-spec.md §TestAgent).
 *
 * A prompt that fails inside a `<Test>` fails that test. `<TestAgent>` says so
 * with `installPromptFailurePolicy`, a scoped policy the agent `<Prompt>`
 * consults — so nothing here depends on installation order, and a repository
 * component named `Prompt` is left alone.
 *
 * Each `<Test>` receives fresh ACPX state keyed by its lease EvalScope;
 * the state is provisioned by a suspended task spawned into that scope,
 * so halting the lease tears the provider down (canceling turns and
 * closing workers) and removes the map entry on normal and failure
 * paths alike. Outside a `<Test>`, the `<TestAgent>` scope itself is
 * the isolation boundary.
 *
 * Scenario scenarios are resources held by suspended tasks spawned into
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
import {
  Agent,
  Component,
  expandSegments,
  installPromptFailurePolicy,
  raise,
} from "@executablemd/core";
import type { ComponentElement, ErrorSegment, Segment, Session } from "@executablemd/core";
import type { AcpxProvider, SessionRouteContext } from "@executablemd/acp";
import { command, cwd as contextualCwd, readTextFile } from "@executablemd/runtime";
import { Test } from "@executablemd/testing";
import { useTestAgentController } from "./controller.ts";
import type { ScenarioHandle, TestAgentControllerInternals } from "./controller.ts";
import { useTestAgentProvider } from "./provider.ts";

/** One `<TestAgent.Scenario>` mapping, before any worker exists. */
interface ScenarioDeclaration {
  agent: string;
  sessionName: string;
  rootDir: string;
  document: { path: string; source: string };
  duplicate: boolean;
}

/** A resolved session, with the agent that created it. */
interface PinnedSession {
  agent: string;
  scenario: ScenarioHandle;
}

interface BoundaryState {
  provider: AcpxProvider;
  /** Owns every scenario resource provisioned for this boundary. */
  boundaryScope: Scope;
  scenarios: Map<string, ScenarioHandle>;
  pending: Map<string, Operation<ScenarioHandle>>;
  bySessionKey: Map<string, PinnedSession>;
}

interface TestAgentSession {
  defaultAgent: string;
  controller: TestAgentControllerInternals;
  declarations: Map<string, ScenarioDeclaration>;
  boundary(): Operation<BoundaryState>;
}

const TestAgentCtx = createContext<TestAgentSession | undefined>("testAgent.session", undefined);

function configError(source: string, message: string): ErrorSegment {
  return { type: "error", message: `<${source}> ${message}`, source };
}

function declarationKey(agent: string, sessionName: string): string {
  // JSON encoding keeps the key textual and collision-safe for any
  // agent/session values.
  return JSON.stringify([agent, sessionName]);
}

function scenarioKey(agent: string, sessionName: string | undefined, dir: string): string {
  return JSON.stringify([declarationKey(agent, sessionName ?? ""), dir]);
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

export function* installTestAgentComponents(): Operation<void> {
  function* expandTestAgent(element: ComponentElement): Operation<Segment[]> {
    if (!(yield* Test.operations.sessionActive)) {
      return [
        yield* raise(
          configError(
            "TestAgent",
            "is valid only in an active testing session created by xmd test or useTesting().",
          ),
        ),
      ];
    }
    const agentProp = element.props.agent;
    if (agentProp !== undefined && typeof agentProp !== "string") {
      return [yield* raise(configError("TestAgent", 'the "agent" prop must be a string literal.'))];
    }
    const defaultAgent = typeof agentProp === "string" ? agentProp : "test";

    return yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const declarations = new Map<string, ScenarioDeclaration>();
      const boundaries = new Map<EvalScope | "test-agent-scope", BoundaryState>();

      function* resolveScenario(
        state: BoundaryState,
        agentName: string,
        sessionName: string | undefined,
        dir: string,
      ): Operation<ScenarioHandle> {
        const declared = declarations.get(declarationKey(agentName, sessionName ?? ""));
        if (!declared) {
          throw new Error(
            `no <TestAgent.Scenario> maps ${describeMapping(agentName, sessionName)}`,
          );
        }
        if (declared.duplicate) {
          throw new Error(
            `duplicate <TestAgent.Scenario> mappings for ${describeMapping(agentName, sessionName)}`,
          );
        }
        const key = scenarioKey(agentName, sessionName, dir);
        const existing = state.scenarios.get(key);
        if (existing) {
          return existing;
        }
        const inFlight = state.pending.get(key);
        if (inFlight) {
          return yield* inFlight;
        }
        // Publish the shared future before acquiring so concurrent
        // callers await this acquisition instead of starting their own.
        const ready = withResolvers<ScenarioHandle>();
        state.pending.set(key, ready.operation);
        yield* state.boundaryScope.spawn(function* () {
          let scenario: ScenarioHandle;
          try {
            scenario = yield* controller.useScenario({
              document: declared.document,
              rootDir: declared.rootDir,
            });
          } catch (error) {
            // Nothing consumes this task's failure yet, so it is
            // reported through the future the callers are waiting on.
            state.pending.delete(key);
            ready.reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          state.scenarios.set(key, scenario);
          state.pending.delete(key);
          ready.resolve(scenario);
          // Held, not caught: the future has settled, so a later
          // failure must reach the boundary scope to fail the test.
          yield* suspend();
        });
        return yield* ready.operation;
      }

      function* provisionState(): Operation<BoundaryState> {
        // The maps exist before useTestAgentProvider so the route resolver
        // can close over them.
        const scenarios = new Map<string, ScenarioHandle>();
        const bySessionKey = new Map<string, PinnedSession>();
        const resolveRoute = (context: SessionRouteContext): string => {
          if (typeof context.session === "object") {
            return resolvePinned(bySessionKey, context.session.sessionKey, context.agentName)
              .scenario.route;
          }
          const scenario = scenarios.get(
            scenarioKey(context.agentName, context.session, context.cwd),
          );
          if (!scenario) {
            throw new Error(
              `no <TestAgent.Scenario> maps ${describeMapping(context.agentName, context.session)}`,
            );
          }
          return scenario.route;
        };
        // Asked for here, not at install time: a document with no
        // <TestAgent> never needs a worker, and must run even where no
        // entrypoint installed a command adapter.
        const workerCommand = yield* command(["test-agent"]);
        const provider = yield* useTestAgentProvider({
          defaultAgent,
          agents: [defaultAgent],
          workerCommand,
          probeRoute: controller.probeRoute,
          resolveRoute,
        });
        return {
          provider,
          boundaryScope: yield* useScope(),
          scenarios,
          pending: new Map(),
          bySessionKey,
        };
      }

      // The <TestAgent> scope itself is the fallback isolation boundary.
      const fallback = yield* provisionState();
      boundaries.set("test-agent-scope", fallback);

      function* boundary(): Operation<BoundaryState> {
        const within = yield* Test.operations.inTest;
        // The test's own scope, not the nearest one: a `<Prompt>` is a component
        // invocation with an eval scope of its own, so asking for the nearest
        // would give every prompt a boundary of its own and nothing a test
        // established would reach the next prompt in it.
        const lease = yield* Test.operations.testScope;
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

      const session: TestAgentSession = { defaultAgent, controller, declarations, boundary };
      yield* TestAgentCtx.set(session);

      // A prompt that fails inside a `<Test>` fails that test rather than
      // rendering its diagnostic and letting the rest of the test run against
      // an answer that never arrived. Being installed here is what scopes it:
      // only prompts under this `<TestAgent>` consult it, and only the agent
      // `<Prompt>` reads it at all.
      yield* installPromptFailurePolicy(() => Test.operations.inTest);

      yield* Agent.around(
        {
          *agent([name], _next) {
            const state = yield* boundary();
            return yield* state.provider.agent(name);
          },
          *session([name], _next) {
            const state = yield* boundary();
            const agentName = yield* Agent.operations.agent();
            const dir = resolve(yield* contextualCwd());
            const scenario = yield* resolveScenario(state, agentName, name, dir);
            // The provider's session() drives withSessionRoute itself;
            // it maps this same context back to the scenario route.
            const resolved = yield* state.provider.session(name);
            state.bySessionKey.set(resolved.sessionKey, { agent: agentName, scenario });
            return resolved;
          },
          *prompt([content, promptOptions], _next) {
            // Routing flows through the provider's withSessionRoute hook,
            // whose resolver is synchronous — so the scenario it will
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
                  yield* resolveScenario(state, agentName, pinned, dir);
                }
                const stream = state.provider.promptStream(content, promptOptions);
                return yield* stream;
              },
            };
          },
        },
        { at: "min" },
      );

      const segments = yield* expandSegments(element.children);
      return segments;
    });
  }

  function* expandScenario(element: ComponentElement): Operation<Segment[]> {
    const session = yield* TestAgentCtx.expect();
    if (session === undefined) {
      return [yield* raise(configError("TestAgent.Scenario", "is valid only inside <TestAgent>."))];
    }
    const { agent, session: sessionProp, src } = element.props;
    if (typeof src !== "string" || src.length === 0) {
      return [yield* raise(configError("TestAgent.Scenario", 'requires a "src" prop.'))];
    }
    if (agent !== undefined && typeof agent !== "string") {
      return [
        yield* raise(
          configError("TestAgent.Scenario", 'the "agent" prop must be a string literal.'),
        ),
      ];
    }
    if (sessionProp !== undefined && typeof sessionProp !== "string") {
      return [
        yield* raise(
          configError("TestAgent.Scenario", 'the "session" prop must be a string literal.'),
        ),
      ];
    }

    const declaredIn = element.position?.path;
    const baseDir = declaredIn ? dirname(declaredIn) : ".";
    const srcPath = isAbsolute(src) ? src : resolve(baseDir, src);
    const source = yield* readTextFile(srcPath);

    const agentName = typeof agent === "string" ? agent : session.defaultAgent;
    const key = declarationKey(agentName, typeof sessionProp === "string" ? sessionProp : "");
    const existing = session.declarations.get(key);
    if (existing) {
      existing.duplicate = true;
      return [];
    }
    session.declarations.set(key, {
      agent: agentName,
      sessionName: typeof sessionProp === "string" ? sessionProp : "",
      rootDir: dirname(srcPath),
      document: { path: basename(srcPath), source },
      duplicate: false,
    });
    return [];
  }

  yield* Component.around({
    *expand([element], next) {
      if (element.name === "TestAgent") {
        return { segments: yield* expandTestAgent(element) };
      }
      if (element.name === "TestAgent.Scenario") {
        return { segments: yield* expandScenario(element) };
      }
      return yield* next(element);
    },
  });
}

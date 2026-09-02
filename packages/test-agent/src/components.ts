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
 * their boundary scope, so a boundary halt releases them. Because acquiring one
 * is an operation but the ACPX registry resolves routes synchronously, every
 * instance is provisioned inside the provider's own `withSessionRoute` hook —
 * which may suspend — before the route it produces is pinned.
 *
 * One ACP provider is installed here, in the `<TestAgent>` invocation, over as
 * many partitions as there are tests. Installation says where the provider can
 * be reached from and is the only thing holding launch authority; the partition
 * a dispatch selects says which state it acts on.
 */

import { createContext, Err, Ok, spawn, suspend, useScope, withResolvers } from "effection";
import type { Operation, Result, Scope } from "effection";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { EvalScope } from "@effectionx/scope-eval";
import {
  Component,
  installPromptFailurePolicy,
  getExpansion,
  raise,
  registerAgentProvider,
  registerComponents,
  tryContent,
  useProviderInstallation,
} from "@executablemd/core";
import type { ErrorSegment, Json, PropsSchema, Segment } from "@executablemd/core";
import { createMemorySessionRouteStore, createPartitionedAcpxProvider } from "@executablemd/acp";
import type { AcpxProvider, SessionRouteContext } from "@executablemd/acp";
import { command, installControlledLauncher, readTextFile } from "@executablemd/runtime";
import { Test } from "@executablemd/testing";
import { NativeLaunchObserver, useTestAgentController } from "./controller.ts";
import type { ScenarioHandle, TestAgentControllerInternals } from "./controller.ts";
import { createControlledExecutableObserver } from "./executable-observer.ts";
import { createDeterministicSessionCoordinator } from "./session-coordinator.ts";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { duplicateScenario, missingScenario } from "./child-configuration.ts";
import { TEST_AGENT_CLIENT_NATIVE, TEST_AGENT_PROVIDER, useTestAgentProvider } from "./provider.ts";
import type { SessionRouting } from "./provider.ts";

/** The agent a `<TestAgent>` answers for when the element names none. */
export const DEFAULT_TEST_AGENT = "test";

/** One `<TestAgent.Scenario>` mapping, before any worker exists. */
export interface ScenarioDeclaration {
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

export interface BoundaryState {
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

const TestAgentContext = createContext<TestAgentSession | undefined>(
  "testAgent.session",
  undefined,
);

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
 * The session a pinned operation resolved, if it resolved one.
 *
 * Read off the value rather than declared, because the route hook bounds
 * several different registry-dependent operations and only some of them settle
 * a session. What those have in common is the key, which is all this needs.
 */
function sessionKeyOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const key = Reflect.get(value, "sessionKey");
  return typeof key === "string" ? key : undefined;
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

/**
 * One complete partition: the state a boundary is a world of its own in.
 *
 * Scenario provisioning belongs here, not above the provider, because the route
 * it pins is this partition's and so is the coordinator that says who owns a
 * session. A sibling boundary naming the same agent, session and directory
 * reaches its own of each.
 *
 * Shared by both placements of `<TestAgent>`. The wrapper provisions one of
 * these per enclosing `<Test>`; nested-run configuration provisions one for the
 * ordinary child and a private one for each controlled Plan invocation. Each is
 * acquired inside the child it belongs to and remains its own world.
 */
export function* provisionPartition(options: {
  defaultAgent: string;
  controller: TestAgentControllerInternals;
  declarations: ReadonlyMap<string, ScenarioDeclaration>;
  /** How to re-invoke this host as the agent worker. */
  workerCommand: string[];
  planCeiling?: { readonly dependencies: AcpxProviderDependencies };
}): Operation<BoundaryState> {
  const { defaultAgent, controller, declarations, workerCommand, planCeiling } = options;
  const scenarios = new Map<string, ScenarioHandle>();
  const pending = new Map<string, Operation<ScenarioHandle>>();
  const bySessionKey = new Map<string, PinnedSession>();
  const boundaryScope = yield* useScope();

  function* provision(
    agentName: string,
    sessionName: string | undefined,
    dir: string,
  ): Operation<ScenarioHandle> {
    const declared = declarations.get(declarationKey(agentName, sessionName ?? ""));
    if (!declared) {
      throw new Error(missingScenario(agentName, sessionName ?? ""));
    }
    if (declared.duplicate) {
      throw new Error(duplicateScenario(agentName, sessionName ?? ""));
    }
    const key = scenarioKey(agentName, sessionName, dir);
    const existing = scenarios.get(key);
    if (existing) {
      return existing;
    }
    const inFlight = pending.get(key);
    if (inFlight) {
      return yield* inFlight;
    }
    // Publish the shared future before acquiring so concurrent
    // callers await this acquisition instead of starting their own.
    const ready = withResolvers<ScenarioHandle>();
    pending.set(key, ready.operation);
    yield* boundaryScope.spawn(function* () {
      let scenario: ScenarioHandle;
      try {
        scenario = yield* controller.useScenario({
          document: declared.document,
          rootDir: declared.rootDir,
        });
      } catch (error) {
        // Nothing consumes this task's failure yet, so it is
        // reported through the future the callers are waiting on.
        pending.delete(key);
        ready.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      scenarios.set(key, scenario);
      pending.delete(key);
      ready.resolve(scenario);
      // Held, not caught: the future has settled, so a later
      // failure must reach the boundary scope to fail the test.
      yield* suspend();
    });
    return yield* ready.operation;
  }

  /**
   * Place one registry-dependent operation in this partition.
   *
   * Suspending is allowed here and forbidden in `registry.resolve()`, so
   * this is where a scenario is acquired — before the route it produces
   * is pinned and the provider's own work begins.
   */
  function* routeFor(context: SessionRouteContext): Operation<SessionRouting> {
    if (typeof context.session === "object") {
      // Established by an earlier operation in this partition. Provisioning
      // it again would key it as the unnamed session and route elsewhere.
      const pinned = resolvePinned(bySessionKey, context.session.sessionKey, context.agentName);
      return { route: pinned.scenario.route, resolved: () => {} };
    }
    const scenario = yield* provision(context.agentName, context.session, context.cwd);
    return {
      route: scenario.route,
      resolved(value) {
        const sessionKey = sessionKeyOf(value);
        if (sessionKey !== undefined) {
          bySessionKey.set(sessionKey, { agent: context.agentName, scenario });
        }
      },
    };
  }

  const provider = yield* useTestAgentProvider({
    defaultAgent,
    // Two agents, because the two construction routes are two contracts:
    // the default one's worker asserts its own identity, and the second
    // is named by XMD before any process exists.
    agents: [defaultAgent, TEST_AGENT_CLIENT_NATIVE],
    workerCommand,
    probeRoute: controller.probeRoute,
    routeFor,
    // This partition's own, so two boundaries owning "the same" session are
    // owning two sessions and never exclude each other — and so a route
    // one published is not an account the next has to live with.
    coordinator: createDeterministicSessionCoordinator(),
    // And its own build, so a client-allocated session in one boundary is
    // bound to a build the next does not share.
    executableObserver: createControlledExecutableObserver().observer,
    routeStore: createMemorySessionRouteStore(),
    ...(planCeiling === undefined ? {} : { planCeiling }),
  });
  return { provider, boundaryScope, scenarios, pending, bySessionKey };
}

/**
 * `<TestAgent>` as an ordinary wrapper: scripted Agent behavior for the
 * assertion content it encloses.
 *
 * Exported so a trusted harness can recognize the declaration form by the
 * definition ordinary resolution selected. Nothing calls it directly.
 */
export function* TestAgent(props: Record<string, Json>): Operation<unknown> {
  if (!(yield* Test.operations.sessionActive)) {
    // Raised for the observation chain, returned as text for the document:
    // one of each, which is what returning the segment used to do.
    const reported = yield* raise(
      configError(
        "TestAgent",
        "is valid only in an active testing session created by xmd test or useTesting().",
      ),
    );
    return reported.message;
  }
  const defaultAgent = typeof props.agent === "string" ? props.agent : DEFAULT_TEST_AGENT;

  // NOT wrapped in scoped(): content projected by tryContent() anchors to the
  // invocation, not to a child frame, so anything installed inside a scoped()
  // here would be invisible to the body. The invocation is already the bound
  // this region needs — it is dismantled with the component.
  const controller = yield* useTestAgentController();
  const declarations = new Map<string, ScenarioDeclaration>();
  const boundaries = new Map<EvalScope | "test-agent-scope", BoundaryState>();
  // Asked for here, not at install time: a document with no
  // <TestAgent> never needs a worker, and must run even where no
  // entrypoint installed a command adapter.
  const workerCommand = yield* command(["test-agent"]);

  function partition(): Operation<BoundaryState> {
    return provisionPartition({ defaultAgent, controller, declarations, workerCommand });
  }

  // The <TestAgent> scope itself is the fallback isolation boundary.
  const fallback = yield* partition();
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
          const state = yield* partition();
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
  yield* TestAgentContext.set(session);

  // A prompt that fails inside a `<Test>` fails that test rather than
  // rendering its diagnostic and letting the rest of the test run against
  // an answer that never arrived. Being installed here is what scopes it:
  // only prompts under this `<TestAgent>` consult it, and only the agent
  // `<Prompt>` reads it at all.
  yield* installPromptFailurePolicy(() => Test.operations.inTest);

  // The test agent's native UI is fictional in the way its agent is: the
  // worker asserts a native identity, and nothing here has a UI to resume
  // it in. So a launch under this component is recorded and answered
  // rather than started, and never reaches the host's terminal — which is
  // also what lets an authored `<Session.Launch>` run under `xmd test`,
  // where no host launcher exists at all.
  yield* installControlledLauncher({ ...(yield* NativeLaunchObserver.get()) });

  // One installation, many partitions.
  //
  // Installing here — in the invocation the content is projected into — is
  // what makes the provider reachable from that content at all, and it is
  // also what makes it the only thing holding this document's launch
  // authority. Selecting per test is what keeps one test's sessions, queues
  // and records out of the next. Neither is a substitute for the other, and
  // the selector carries no authority: it answers with a partition, which
  // is work, never permission.
  yield* registerAgentProvider(
    TEST_AGENT_PROVIDER,
    createPartitionedAcpxProvider(function* () {
      return (yield* boundary()).provider;
    }),
  );
  yield* useProviderInstallation(TEST_AGENT_PROVIDER, {
    defaultAgent,
    permissionMode: "deny-all",
  });

  // The <Testing> completion shape, not content(): a body may legally hold
  // a settled diagnostic beside healthy scenarios, and content() would
  // replace this invocation's output with those segments. `text` keeps them
  // inline exactly as the segments this replaced did. A body that genuinely
  // stopped is different — that failure travels on untouched.
  const projected = yield* tryContent();
  if (projected.failure !== undefined) {
    throw projected.failure;
  }
  return projected.text;
}

/**
 * `<TestAgent.Scenario>` as an ordinary child of the wrapper.
 *
 * Exported for the same reason `TestAgent` is: a harness that recognized the
 * declaration accepts this exact definition inside it and nothing else.
 */
export function* Scenario(props: Record<string, Json>): Operation<unknown> {
  const session = yield* TestAgentContext.get();
  if (session === undefined) {
    const reported = yield* raise(
      configError("TestAgent.Scenario", "is valid only inside <TestAgent>."),
    );
    return reported.message;
  }
  const { agent, session: sessionProp, src } = props;
  if (typeof src !== "string" || src.length === 0) {
    const reported = yield* raise(configError("TestAgent.Scenario", 'requires a "src" prop.'));
    return reported.message;
  }

  const read = yield* readScenarioSource(src);
  if (!read.ok) {
    // The read's own failure, unwrapped: a wrapper's scenario is read while a
    // document is running, so an unreadable one fails the way any other
    // filesystem refusal in a component does.
    throw read.error;
  }

  const agentName = typeof agent === "string" ? agent : session.defaultAgent;
  const sessionName = typeof sessionProp === "string" ? sessionProp : "";
  const key = declarationKey(agentName, sessionName);
  const existing = session.declarations.get(key);
  if (existing) {
    existing.duplicate = true;
    return "";
  }
  session.declarations.set(key, {
    agent: agentName,
    sessionName,
    rootDir: read.value.rootDir,
    document: read.value.document,
    duplicate: false,
  });
  return "";
}

/**
 * Read one behavior document, relative to the document that named it.
 *
 * The containment root is the directory the source was found in, which is what
 * the controller serves the document's own Markdown dependencies from. Shared
 * by both placements, so a nested-run declaration resolves `src` exactly as the
 * wrapper does — from the outer test document, never from the child.
 *
 * A refusal comes back rather than being thrown, because the two placements
 * report it differently: a wrapper is reading while a document runs and lets
 * the failure travel, while a declaration is configuring a child that has not
 * started and reports it as that child's refusal.
 */
export function* readScenarioSource(
  src: string,
): Operation<Result<{ rootDir: string; document: { path: string; source: string } }>> {
  const declaredIn = (yield* getExpansion()).position?.path;
  const baseDir = declaredIn ? dirname(declaredIn) : ".";
  const srcPath = isAbsolute(src) ? src : resolve(baseDir, src);
  try {
    const source = yield* readTextFile(srcPath);
    return Ok({ rootDir: dirname(srcPath), document: { path: basename(srcPath), source } });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

export function* installTestAgentComponents(): Operation<void> {
  // Non-reserved defaults: a repository component of either name is chosen
  // ahead of these. The dotted name addresses a subdirectory, so the override
  // for the second is components/TestAgent/Scenario.md.
  yield* registerComponents([
    {
      name: "TestAgent",
      origin: "@executablemd/test-agent",
      fn: TestAgent,
      props: TEST_AGENT_PROPS,
    },
    {
      name: "TestAgent.Scenario",
      origin: "@executablemd/test-agent",
      fn: Scenario,
      props: SCENARIO_PROPS,
    },
  ]);
}

export const TEST_AGENT_PROPS: PropsSchema = {
  type: "object",
  properties: { agent: { type: "string" } },
  additionalProperties: false,
};

export const SCENARIO_PROPS: PropsSchema = {
  type: "object",
  properties: {
    src: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
  },
  required: ["src"],
  additionalProperties: false,
};

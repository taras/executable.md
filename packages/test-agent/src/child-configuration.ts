/**
 * `<TestAgent>` as configuration for one nested run
 * (specs/test-agent-spec.md, "Configuring one nested run").
 *
 * The wrapper form scripts the Agent an assertion body reaches. This is the
 * other placement: written as a direct declaration in an
 * `<Execution host="run">` prefix, `<TestAgent>` scripts the Agent the *child*
 * reaches, and the child is a document nobody edited to be testable.
 *
 * ```mdx
 * <Execution host="run" target="./review.md" as="run">
 *   <TestAgent agent="reviewer">
 *     <TestAgent.Scenario session="review" src="./agents/review.md" />
 *   </TestAgent>
 *
 *   <AssertEquals actual={run.result.ok} expected={true} />
 * </Execution>
 * ```
 *
 * Two halves, and the boundary between them is why they are apart:
 *
 * - **Reading the declaration** happens in the test, where `src` resolves and
 *   the behavior document is on disk. What it produces is frozen values.
 * - **Assembling the provider** happens in the child, and the trusted host is
 *   what calls it. Nothing constructed here crosses — the controller, the
 *   provider, the launcher and the worker connection are created inside the
 *   child's own scope and finish teardown with it.
 *
 * The declaration is recognized by the definition ordinary resolution
 * selected, so a repository `TestAgent.md` is an ordinary component that ends
 * the scan and configures nothing.
 */

import type { Operation } from "effection";
import { hasContent, registerAgentProvider, tryContent } from "@executablemd/core";
import type { AgentComponentsOptions, AgentProviderOptions, Json } from "@executablemd/core";
import { createPartitionedAcpxProvider } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { installInvocationAgentProvider } from "@executablemd/core/host";
import { installControlledLauncher } from "@executablemd/runtime";
import type {
  ChildDeclaration,
  ChildDeclarationChild,
  ChildScenario,
  OpenChildDeclaration,
  TestAgentChildConfiguration,
} from "@executablemd/testing";
import { useTestAgentController } from "./controller.ts";
import {
  DEFAULT_TEST_AGENT,
  provisionPartition,
  readScenarioSource,
  Scenario,
  TestAgent,
} from "./components.ts";
import type { ScenarioDeclaration } from "./components.ts";
import { TEST_AGENT_PROVIDER } from "./provider.ts";

const TEST_AGENT = "TestAgent";
const SCENARIO = "TestAgent.Scenario";

function mappingKey(agent: string, session: string): string {
  // JSON encoding keeps the key textual and collision-safe for any
  // agent/session values.
  return JSON.stringify([agent, session]);
}

function describeMapping(agent: string, session: string): string {
  return `agent "${agent}" and session "${session === "" ? "(default)" : session}"`;
}

/**
 * What this package contributes to a trusted harness so `<TestAgent>` can
 * configure a nested run.
 *
 * The exact definitions it registers, handed over by identity. A harness that
 * resolved a different definition for either name has resolved an ordinary
 * component, and this recognizes none of it.
 */
export function testAgentChildDeclaration(): ChildDeclaration {
  return {
    name: TEST_AGENT,
    definition: TestAgent,
    open,
  };
}

function open(collect: {
  configure(configuration: TestAgentChildConfiguration): void;
  refuse(problem: string): void;
}): OpenChildDeclaration {
  const scenarios: ChildScenario[] = [];
  const mapped = new Set<string>();
  let defaultAgent = DEFAULT_TEST_AGENT;
  let malformed = false;

  function refuse(problem: string): void {
    malformed = true;
    collect.refuse(problem);
  }

  const declareScenario: ChildDeclarationChild = function* (
    props: Record<string, Json>,
  ): Operation<string> {
    const { agent, session: sessionProp, src } = props;
    if (typeof src !== "string" || src.length === 0) {
      refuse(`<${SCENARIO}> requires a "src" prop.`);
      return "";
    }
    const read = yield* readScenarioSource(src);
    if (!read.ok) {
      refuse(`<${SCENARIO}> cannot read the behavior document "${src}": ${read.error.message}`);
      return "";
    }
    const agentName = typeof agent === "string" ? agent : defaultAgent;
    const session = typeof sessionProp === "string" ? sessionProp : "";
    const key = mappingKey(agentName, session);
    if (mapped.has(key)) {
      // Refused where it is written rather than where it would be used: the
      // wrapper can only find out when a prompt asks for the mapping, and a
      // child has not been created yet for one to ask in.
      refuse(`<${SCENARIO}> maps ${describeMapping(agentName, session)} more than once.`);
      return "";
    }
    mapped.add(key);
    scenarios.push({
      agent: agentName,
      session,
      rootDir: read.value.rootDir,
      document: read.value.document,
    });
    return "";
  };

  return {
    name: TEST_AGENT,
    children: new Map<unknown, ChildDeclarationChild>([[Scenario, declareScenario]]),
    *expand(props: Record<string, Json>): Operation<string> {
      defaultAgent = typeof props.agent === "string" ? props.agent : DEFAULT_TEST_AGENT;
      if (yield* hasContent()) {
        const projected = yield* tryContent();
        if (projected.failure !== undefined) {
          throw projected.failure;
        }
        if (projected.text.trim() !== "") {
          refuse(
            `<${TEST_AGENT}> configures a child, so it holds <${SCENARIO}> declarations alone.`,
          );
        }
      }
      if (scenarios.length === 0 && !malformed) {
        refuse(`<${TEST_AGENT}> configures a child, so it requires at least one <${SCENARIO}>.`);
      }
      if (!malformed) {
        collect.configure({ kind: "test-agent", defaultAgent, scenarios });
      }
      return "";
    },
  };
}

/**
 * Build this package's Agent behavior inside one nested child.
 *
 * Called by the trusted host, in the child's own isolated scope, from the
 * frozen data one declaration produced. This child is the isolation boundary,
 * so a sibling execution repeating the same declarations reaches its own
 * controller, workers, routes and logical sessions. The ordinary provider has
 * one partition; each controlled Plan invocation gets a private partition so
 * its derived identity and working directory cannot meet a sibling's state.
 *
 * What comes back is what the host passes to `installAgentComponents()`. The
 * wrapper installs its provider from inside a running document, where
 * `<AgentProvider>`'s installation protocol is reachable; a child's assembly
 * happens before its execution exists, so the provider travels as the root
 * provider the execution installs for itself — the same route `xmd run` uses
 * for `acpx`.
 *
 * The prompt-failure policy the wrapper installs is deliberately not here. A
 * child is an ordinary run, and a prompt that fails in one fails the run — the
 * outcome the `<Execution>` binds — rather than an enclosing `<Test>` the child
 * cannot see.
 */

/** What a Plan's controlled provider is built from, assembled from the policy. */
function planProviderDependencies(
  workdir: string,
  policy: PlanProviderPolicy,
): AcpxProviderDependencies {
  return {
    // deno-lint-ignore require-yield
    *agentCwd(): Operation<string> {
      return workdir;
    },
    mcpServers: [...policy.mcpServers],
    permissions: "strict",
    newSessionOptions: {
      systemPrompt: policy.systemInstruction,
      allowedTools: [...policy.allowedTools],
    },
  };
}

/** The fixed policy a trusted host states for one Plan invocation. */
export interface PlanProviderPolicy {
  readonly systemInstruction: string;
  readonly permissionMode: "deny-all";
  readonly mcpServers: readonly never[];
  readonly allowedTools: readonly never[];
}

/**
 * One installed provider, as the objects it was installed with.
 *
 * Not a description built beside the installation but the installation itself:
 * the same value registers the provider, installs the invocation options, and
 * is handed to a trusted host as the observation. There is nothing for a report
 * to disagree with, because there is no second report.
 */
export interface PlanProviderAssembly {
  /** The identity registered and selected for this invocation. */
  readonly provider: string;
  /** The dependencies the provider was built from, as the provider holds them. */
  readonly dependencies: AcpxProviderDependencies;
  /** The options the invocation provider was installed with. */
  readonly invocation: AgentProviderOptions;
}

/** What a Plan whose scenario nobody declared is refused with. */
export function missingScenario(agent: string, session: string): string {
  return `No <TestAgent.Scenario> was found for agent "${agent}" and session "${session}".`;
}

/** What a Plan whose scenario was declared twice is refused with. */
export function duplicateScenario(agent: string, session: string): string {
  return (
    `More than one <TestAgent.Scenario> was declared for agent "${agent}" and ` +
    `session "${session}".`
  );
}

export interface ChildTestAgentInstallation {
  readonly components: AgentComponentsOptions;
  installPlanProvider(request: {
    readonly agent: string;
    readonly authoredSession?: string;
    readonly session: string;
    readonly workdir: string;
    readonly policy: PlanProviderPolicy;
  }): Operation<PlanProviderAssembly>;
}

export function* installChildTestAgent(
  configuration: TestAgentChildConfiguration,
  options: {
    /** How the trusted entrypoint re-invokes itself as the agent worker. */
    readonly workerCommand: readonly string[];
  },
): Operation<ChildTestAgentInstallation> {
  const controller = yield* useTestAgentController();
  const declarations = new Map<string, ScenarioDeclaration>();
  for (const scenario of configuration.scenarios) {
    declarations.set(mappingKey(scenario.agent, scenario.session), {
      agent: scenario.agent,
      sessionName: scenario.session,
      rootDir: scenario.rootDir,
      document: { path: scenario.document.path, source: scenario.document.source },
      duplicate: false,
    });
  }
  const partition = yield* provisionPartition({
    defaultAgent: configuration.defaultAgent,
    controller,
    declarations,
    workerCommand: [...options.workerCommand],
  });
  // deno-lint-ignore require-yield
  const factory = createPartitionedAcpxProvider(function* () {
    return partition.provider;
  });
  yield* registerAgentProvider(TEST_AGENT_PROVIDER, factory);
  // A launch under a controlled provider is recorded and answered rather than
  // started. The child has no observer of its own — the outer test's is not
  // reachable from here, which is the isolation working — so what this
  // installs is the refusal to reach a terminal, and nothing that watches.
  yield* installControlledLauncher({});
  const permissionMode = "deny-all";
  return {
    components: {
      defaultAgent: configuration.defaultAgent,
      permissionMode,
      rootProvider: {
        factory,
        options: { defaultAgent: configuration.defaultAgent, permissionMode },
      },
    },
    *installPlanProvider(request): Operation<PlanProviderAssembly> {
      const planDeclarations = new Map(declarations);
      if (request.authoredSession !== undefined) {
        const declared = declarations.get(mappingKey(request.agent, request.authoredSession));
        if (declared === undefined) {
          throw new Error(missingScenario(request.agent, request.authoredSession));
        }
        const key = mappingKey(request.agent, request.session);
        const existing = planDeclarations.get(key);
        if (existing !== undefined && existing !== declared) {
          throw new Error(duplicateScenario(request.agent, request.session));
        }
        planDeclarations.set(key, declared);
      }
      // One assembly, used for every installation and handed back as the
      // observation. Nothing is reconstructed afterward, so a report cannot
      // describe an arrangement other than the one installed.
      const plan = yield* provisionPartition({
        defaultAgent: configuration.defaultAgent,
        controller,
        declarations: planDeclarations,
        workerCommand: [...options.workerCommand],
        planConfiguration: {
          dependencies: planProviderDependencies(request.workdir, request.policy),
        },
      });
      const installed: PlanProviderAssembly = {
        provider: TEST_AGENT_PROVIDER,
        // The partition's own account of what its provider holds, so a provider
        // built from anything but the assembled Plan dependencies reports as
        // what it actually is rather than as what was asked for.
        dependencies: plan.dependencies,
        invocation: {
          defaultAgent: request.agent,
          permissionMode: request.policy.permissionMode,
        },
      };
      // deno-lint-ignore require-yield
      const planFactory = createPartitionedAcpxProvider(function* () {
        return plan.provider;
      });
      yield* registerAgentProvider(installed.provider, planFactory);
      yield* installInvocationAgentProvider(installed.provider, installed.invocation);
      return installed;
    },
  };
}

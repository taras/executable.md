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
import type { AgentComponentsOptions, Json } from "@executablemd/core";
import { createPartitionedAcpxProvider } from "@executablemd/acp";
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
 * frozen data one declaration produced. Exactly one partition: this child is
 * the isolation boundary, so a sibling execution repeating the same
 * declarations reaches its own controller, its own worker, its own routes and
 * its own logical sessions, and a named session continues only within the
 * child whose declaration created it.
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
export function* installChildTestAgent(
  configuration: TestAgentChildConfiguration,
  options: {
    /** How the trusted entrypoint re-invokes itself as the agent worker. */
    readonly workerCommand: readonly string[];
  },
): Operation<AgentComponentsOptions> {
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
    defaultAgent: configuration.defaultAgent,
    permissionMode,
    rootProvider: {
      factory,
      options: { defaultAgent: configuration.defaultAgent, permissionMode },
    },
  };
}

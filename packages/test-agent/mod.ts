/**
 * @module
 * Build reliable ACP integration tests with deterministic,
 * document-driven agent behavior. In place of a probabilistic coding
 * agent, the test agent answers ACP prompts by advancing through a
 * Markdown behavior document, so an integration can be tested against
 * scripted, repeatable responses (specs/test-agent-spec.md).
 *
 * A harness needs three things from here: `installTestAgentComponents()` to
 * teach a document `<TestAgent>`, `useTestAgentController()` to register
 * scenarios and serve them, and `runTestAgentWorker()` for the process that
 * answers as the agent. The behavior-document engine, the wire protocol
 * between controller and worker, and the scenario records they exchange are
 * implementation.
 */

import type { Operation } from "effection";
import { useTestAgentController as useController } from "./src/controller.ts";
import type { ScenarioHandle, TestAgentController } from "./src/controller.ts";

export type { ScenarioHandle, TestAgentController } from "./src/controller.ts";

/**
 * Acquire the controller for the calling scope: a localhost server that serves
 * behavior documents to workers and tears every scenario down with the scope.
 *
 * What comes back is a facade, not the controller the package uses: it carries
 * `useScenario` alone, and hands back a fresh `{ route }` for each scenario. The
 * probe route, the record lookup, and a scenario's journal, identity, and
 * diagnostics stay inside the package at runtime, not only in the types.
 */
export function* useTestAgentController(): Operation<TestAgentController> {
  const controller = yield* useController();
  return {
    *useScenario(options): Operation<ScenarioHandle> {
      // Acquired here, so the record's resource belongs to the caller's scope
      // exactly as it would through the internal controller.
      const record = yield* controller.useScenario(options);
      return { route: record.route };
    },
  };
}

export { installTestAgentComponents } from "./src/components.ts";
export { runTestAgentWorker } from "./src/worker/run.ts";

/**
 * `<TestAgent>` as configuration for one nested `host="run"` execution
 * (specs/testing-spec.md, specs/test-agent-spec.md).
 *
 * Two halves for a trusted host to hold apart. `testAgentChildDeclaration()`
 * is what a test harness recognizes the declaration by — this package's exact
 * definitions, handed over by identity — and what reads one into frozen data.
 * `installChildTestAgent()` is what turns that data back into a provider, and
 * the host calls it inside the child's own isolated scope. Nothing constructed
 * by the first crosses into the second.
 */
export { installChildTestAgent, testAgentChildDeclaration } from "./src/child-configuration.ts";
export type { ChildTestAgentInstallation } from "./src/child-configuration.ts";

/**
 * The provider name a controlled child registers its Agent under.
 *
 * Published so a trusted host can install that same provider again where it
 * needs one — under the Plan authorship ceiling, which registers its own
 * provider for the invocation rather than inheriting whatever surrounds it.
 * Holding the name grants nothing: what it resolves to is the partition the
 * host provisioned for that child.
 */
export { TEST_AGENT_PROVIDER } from "./src/provider.ts";

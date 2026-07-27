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
import type { TestAgentController } from "./src/controller.ts";

export type { ScenarioHandle, TestAgentController } from "./src/controller.ts";

/**
 * Acquire the controller for the calling scope: a localhost server that serves
 * behavior documents to workers and tears every scenario down with the scope.
 */
export function useTestAgentController(): Operation<TestAgentController> {
  return useController();
}

export { installTestAgentComponents } from "./src/components.ts";
export type { TestAgentComponentsOptions } from "./src/components.ts";
export { runTestAgentWorker } from "./src/worker/run.ts";

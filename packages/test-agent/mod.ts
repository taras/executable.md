/**
 * @module
 * Build reliable ACP integration tests with deterministic,
 * document-driven agent behavior. In place of a probabilistic coding
 * agent, the test agent answers ACP prompts by advancing through a
 * Markdown behavior document, so an integration can be tested against
 * scripted, repeatable responses (specs/test-agent-spec.md).
 *
 * This entry point exposes the `<TestAgent>` vocabulary, the
 * behavior-document engine, and the controller that registers scenarios
 * and serves them to workers over the wire protocol.
 */

export { parseTemplate, matchPrompt } from "./src/template.ts";
export type {
  ParsedTemplate,
  TemplateMatchResult,
  TemplateParseResult,
  TemplateToken,
} from "./src/template.ts";
export {
  createLineSplitter,
  encodeMessage,
  formatRoute,
  parseControllerMessage,
  parseRoute,
  parseWorkerMessage,
  PROBE_INSTANCE,
} from "./src/protocol.ts";
export type {
  ControllerMessage,
  ParsedRoute,
  ParseResult,
  WireDurableEvent,
  WorkerMessage,
} from "./src/protocol.ts";
export { useTestAgentController } from "./src/controller.ts";
export type { InstanceFailure, ScenarioInstance, TestAgentController } from "./src/controller.ts";
export { installTestAgentVocabulary } from "./src/vocabulary.ts";
export type { TestAgentVocabularyOptions } from "./src/vocabulary.ts";
export { createMemorySessionStore, useTestAgentAcpx } from "./src/state.ts";
export type { TestAgentAcpx, TestAgentAcpxOptions } from "./src/state.ts";
export { runTestAgentWorker } from "./src/worker/run.ts";
export { installWhenPromptVocabulary } from "./src/worker/when-prompt.ts";
export { installWorkerProfile } from "./src/worker/profile.ts";
export type { WorkerFilesystem } from "./src/worker/profile.ts";
export { collectTurn, createTurnBridge } from "./src/worker/bridge.ts";
export type { BridgeEvent, PromptOffer, TurnBridge } from "./src/worker/bridge.ts";

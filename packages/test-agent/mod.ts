/**
 * @module
 * Deterministic ACP test agent for Executable.md
 * (specs/test-agent-spec.md): the `<TestAgent>` vocabulary and the
 * `xmd test-agent` worker runtime.
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
export { createMemorySessionStore, useTestAgentAcpx } from "./src/state.ts";
export type { TestAgentAcpx, TestAgentAcpxOptions } from "./src/state.ts";
export { runTestAgentWorker } from "./src/worker/run.ts";
export { installWhenPromptVocabulary } from "./src/worker/when-prompt.ts";
export { installWorkerProfile } from "./src/worker/profile.ts";
export type { WorkerFilesystem } from "./src/worker/profile.ts";
export { collectTurn, createTurnBridge } from "./src/worker/bridge.ts";
export type { BridgeEvent, PromptOffer, TurnBridge } from "./src/worker/bridge.ts";

/**
 * @module
 * Deterministic ACP test agent for Executable.md
 * (specs/test-agent-spec.md): the behavior-document engine — prompt
 * templates, the turn bridge, and the `<WhenPrompt>` vocabulary.
 */

export { parseTemplate, matchPrompt } from "./src/template.ts";
export type {
  ParsedTemplate,
  TemplateMatchResult,
  TemplateParseResult,
  TemplateToken,
} from "./src/template.ts";
export { installWhenPromptVocabulary } from "./src/worker/when-prompt.ts";
export { collectTurn, createTurnBridge } from "./src/worker/bridge.ts";
export type { BridgeEvent, PromptOffer, TurnBridge } from "./src/worker/bridge.ts";

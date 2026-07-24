/**
 * @module
 * Build reliable ACP integration tests with deterministic,
 * document-driven agent behavior. In place of a probabilistic coding
 * agent, the test agent answers ACP prompts by advancing through a
 * Markdown behavior document, so an integration can be tested against
 * scripted, repeatable responses (specs/test-agent-spec.md).
 *
 * This entry point exposes the behavior-document engine.
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

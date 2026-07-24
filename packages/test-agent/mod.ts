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

/**
 * Executable MDX — public API.
 *
 * Treats markdown documents as durable workflows: text is emitted immediately,
 * component references are resolved and expanded recursively, and code blocks
 * marked as executable are run via durableExec.
 */

export type {
  Segment,
  TextSegment,
  ComponentInvocation,
  ExecutableCodeBlock,
  ExecOutputSegment,
  ErrorSegment,
  ExecResult,
  Modifier,
  ParsedInfoString,
  CodeBlockContext,
  CodeBlockResult,
  InputDefinition,
  ComponentDefinition,
  ImportResult,
  ResolveResult,
  SampleContext,
  Json,
} from "./src/types.ts";

export type { Workflow } from "@executablemd/durable-streams";
export { ephemeral } from "@executablemd/durable-streams";

export { healSegment } from "./src/heal.ts";

export type { Middleware } from "@effectionx/middleware";
export { combine } from "@effectionx/middleware";

export type {
  ModifierFactory,
  ModifierMiddleware,
  CodeBlockWorkflow,
} from "./src/modifiers.ts";
export { useCodeBlock, CodeBlockCtx } from "./src/modifiers.ts";

// ---------------------------------------------------------------------------
// Eval system (generator eval blocks)
// ---------------------------------------------------------------------------

export type { EvalEnv } from "./src/eval-env.ts";
export { EvalEnvCtx, EvalScopeCtx } from "./src/eval-env.ts";

export type { EvalContext } from "./src/eval-context.ts";
export { EvalCtxKey, createEvalContext, compileBlock } from "./src/eval-context.ts";

// ---------------------------------------------------------------------------
// EMA Globals (for generated eval modules)
// ---------------------------------------------------------------------------

export { useContent } from "./src/content-context.ts";
export { Sample } from "./src/sample-api.ts";

export { evalFactory } from "./src/eval-handler.ts";
export { persistFactory } from "./src/modifiers/persist.ts";
export { timeoutFactory, parseDuration } from "./src/modifiers/timeout.ts";
export { daemonFactory } from "./src/modifiers/daemon.ts";

// ---------------------------------------------------------------------------
// Eval binding interpolation
// ---------------------------------------------------------------------------

export { interpolateEvalBindings } from "./src/eval-interpolate.ts";

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

export { findFreePort } from "@executablemd/runtime";

export type { TransformResult } from "./src/eval-transform.ts";
export {
  transformBlock,
  serializeExports,
  isJson,
} from "./src/eval-transform.ts";

// ---------------------------------------------------------------------------
// Output Api & middleware
// ---------------------------------------------------------------------------

export { EMA } from "./src/api.ts";
export type { EMAApi } from "./src/api.ts";
export { useNormalizedOutput } from "./src/output/normalize.ts";
export { useTerminalOutput } from "./src/output/terminal.ts";

// ---------------------------------------------------------------------------
// Document runner
// ---------------------------------------------------------------------------

export { runDocument } from "./src/run-document.ts";
export type { RunDocumentOptions, DocumentExecution } from "./src/run-document.ts";

// ---------------------------------------------------------------------------
// Stream consumption
// ---------------------------------------------------------------------------

export { collect } from "./src/collect.ts";

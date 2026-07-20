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
  SourcePosition,
  InvocationContext,
  InvocationHandling,
} from "./src/types.ts";

export type { Workflow } from "@executablemd/durable-streams";
export { ephemeral } from "@executablemd/durable-streams";

export { healSegment } from "./src/heal.ts";

export type { Middleware } from "@effectionx/middleware";
export { combine } from "@effectionx/middleware";

export type { ModifierFactory, ModifierMiddleware, CodeBlockWorkflow } from "./src/modifiers.ts";
export { useCodeBlock } from "./src/modifiers.ts";


export type { ComponentApi } from "./src/component-api.ts";
export {
  Component,
  importComponent,
  applyModifiers,
  raise,
  env,
  evalScope,
  expandInvocation,
  codeBlock,
  persistent,
  content,
} from "./src/component-api.ts";


export { renderSegments } from "./src/render.ts";


export { createReplayStream } from "./src/replay-stream.ts";
export type { ReplayStream } from "./src/replay-stream.ts";


export type { EvalEnv } from "./src/types.ts";

export { compileBlock } from "./src/eval-context.ts";


export { useContent } from "./src/content-context.ts";
export { Sample } from "./src/sample-api.ts";

export { evalFactory } from "./src/eval-handler.ts";
export { persistFactory } from "./src/modifiers/persist.ts";
export { timeoutFactory, parseDuration } from "./src/modifiers/timeout.ts";
export { daemonFactory } from "./src/modifiers/daemon.ts";


export { interpolateEvalBindings } from "./src/eval-interpolate.ts";


export { findFreePort } from "@executablemd/runtime";

export type { TransformResult } from "./src/eval-transform.ts";
export { transformBlock, serializeExports, isJson } from "./src/eval-transform.ts";


export { DocumentOutput } from "./src/api.ts";
export type { DocumentOutputApi } from "./src/api.ts";
export { useNormalizedOutput } from "./src/output/normalize.ts";
export { useTerminalOutput } from "./src/output/terminal.ts";


export { execute, Execution } from "./src/execute.ts";
export type { ExecuteOptions, ExecutionApi, DocumentExecution } from "./src/execute.ts";
export { useDenoCompiler } from "./src/deno-compiler.ts";
export { useTempFileCompiler } from "./src/temp-file-compiler.ts";


export { collect } from "./src/collect.ts";

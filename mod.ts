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

export { healSegment } from "./src/heal.ts";

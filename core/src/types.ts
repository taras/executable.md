/**
 * Core types for Executable MDX.
 *
 * Defines the Segment intermediate representation, component model types,
 * modifier system types, and shared interfaces.
 */

import type { Operation } from "effection";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";

// ---------------------------------------------------------------------------
// JSON-serializable value type
// ---------------------------------------------------------------------------

export type Json = DurableJson;

// ---------------------------------------------------------------------------
// Segment IR (spec §2.1)
// ---------------------------------------------------------------------------

export type Segment =
  | TextSegment
  | ComponentInvocation
  | ExecutableCodeBlock
  | ExecOutputSegment
  | ErrorSegment;

export interface TextSegment {
  type: "text";
  content: string;
}

export interface ComponentInvocation {
  type: "component";
  name: string;
  props: Record<string, Json>;
  /** Raw expression text for props that need eval at expansion time.
   *  Keyed by prop name. Evaluated against env.values at expansion time.
   *  Always present — empty object {} when no eval expressions exist.
   *  A prop name appears in either props or expressions, never both. */
  expressions: Record<string, string>;
  children: Segment[];
  selfClosing: boolean;
  /**
   * When set, expression props resolve against this env instead of the
   * contextual `env()` binding environment. Used for projected children
   * (substituted via `<Content />`) — they carry the caller's eval env so
   * that expression props like `{pr}` resolve in the lexical scope where
   * the JSX was written, not the wrapping component's scope.
   *
   * This field is NOT part of the parsed IR — it's set at expansion time
   * by substituteContent when projecting children into <Content /> slots.
   */
  projectedEnv?: { values: Record<string, unknown> };
  /**
   * Source location of the opening tag in the original file, frontmatter
   * included. Absent for dynamically scanned strings (render(markdown)).
   */
  position?: SourcePosition;
}

/** A location in an original source file. Lines and columns are 1-based. */
export interface SourcePosition {
  /** Workspace-relative file path. Undefined for dynamically scanned text. */
  path?: string;
  /** Character offset in the original file. */
  offset: number;
  line: number;
  column: number;
}

export interface ExecutableCodeBlock {
  type: "codeBlock";
  language: string;
  content: string;
  modifiers: Modifier[];
  executable: true;
}

export interface ExecOutputSegment {
  type: "execOutput";
  command: string;
  result: ExecResult;
}

export interface ErrorSegment {
  type: "error";
  message: string;
  source?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Shared binding environment for eval blocks within a single component
 * (spec §4.3). Created fresh at the start of component expansion; read
 * contextually via the Component `env` operation.
 */
export interface EvalEnv {
  values: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Invocation-expansion extension hook
// ---------------------------------------------------------------------------

/**
 * Expansion context offered to `expandInvocation` extensions alongside the
 * raw invocation. Exposes exactly what an extension needs: the parent scope's
 * interpolation inputs, caller-projected bindings, and incremental expansion
 * in the current context. Engine internals (hide set, block counter) stay
 * captured inside the `expand` closure.
 */
export interface InvocationContext {
  meta: Record<string, unknown>;
  props: Record<string, Json>;
  /** Caller-projected bindings (segment.projectedEnv) for expression evaluation. */
  projectedEnv?: EvalEnv;
  /** Incrementally expand segments in the current expansion context. */
  expand(segments: Segment[]): Operation<Segment[]>;
}

/**
 * A claimed invocation's replacement segments. `{ segments: [] }` means
 * handled-with-no-output — distinct from `undefined` (unhandled).
 */
export interface InvocationHandling {
  segments: Segment[];
}

// ---------------------------------------------------------------------------
// Modifier system (spec §3.2–3.5)
// ---------------------------------------------------------------------------

export interface ParsedInfoString {
  language: string;
  modifiers: Modifier[];
  executable: boolean;
}

export interface Modifier {
  name: string;
  params?: string;
}

export interface CodeBlockContext {
  language: string;
  content: string;
  blockId: string;
  componentName?: string;
}

export interface CodeBlockResult {
  output: string;
  exitCode: number;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Component model (spec §4.1–4.3)
// ---------------------------------------------------------------------------

export interface InputDefinition {
  type: "string" | "number" | "boolean" | "array" | "object" | "any";
  default?: Json;
  required?: boolean;
  enum?: Json[];
  description?: string;
}

export interface ComponentDefinition {
  kind: "markdown";
  name: string;
  path: string;
  meta: Record<string, unknown>;
  inputs: Record<string, InputDefinition>;
  bodySegments: Segment[];
}

export interface ImportResult extends Record<string, Json> {
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Function components (spec §5.3)
// ---------------------------------------------------------------------------

/**
 * A TypeScript function component — a generator function that receives
 * validated props directly and returns rendered output as a string.
 *
 * Children are available via `useContent()` on the Effection scope:
 * ```ts
 * import { useContent } from "@executablemd/core";
 * import { ephemeral } from "@executablemd/core";
 * export default function*(props) {
 *   const content = yield* ephemeral(useContent());
 *   return `<div>${content}</div>`;
 * }
 * ```
 */
export interface FunctionComponent {
  (props: Record<string, Json>): Workflow<string>;
}

/**
 * Definition for a function component (.ts file).
 * Distinguished from ComponentDefinition by the `kind` field.
 */
export interface FunctionComponentDefinition {
  kind: "function";
  name: string;
  path: string;
  inputs: Record<string, InputDefinition>;
  fn: FunctionComponent;
}

export interface ResolveResult {
  path: string;
}

// ---------------------------------------------------------------------------
// Sample Api context
// ---------------------------------------------------------------------------

export interface SampleContext {
  /** The content to send to the LLM (rendered children or prompt text). */
  content: string;
  /**
   * Model identifier requested by the sample call. Undefined if the author
   * did not specify a model — in which case the innermost active provider wins.
   */
  model?: string;
  /** Additional params for the sample call. */
  params?: string;
  /** System prompt set by enclosing `<Instructions>` components. */
  system?: string;
  /** Name of the component that initiated the sample call. */
  componentName?: string;
}

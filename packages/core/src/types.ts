/**
 * Core types for Executable MDX.
 *
 * Defines the Segment intermediate representation, component model types,
 * modifier system types, and shared interfaces.
 */

import type { Operation } from "effection";
import type { Json as DurableJson } from "@executablemd/durable-streams";

export type Json = DurableJson;

export type JsonObject = { [key: string]: Json };

export type Segment =
  | TextSegment
  | ComponentElement
  | ExecutableCodeBlock
  | ExecOutputSegment
  | ErrorSegment;

export interface TextSegment {
  type: "text";
  content: string;
}

export interface ComponentElement {
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
  /** Structured detail for the error. Present on prop-validation failures. */
  cause?: Json;
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

/**
 * A claimed element's replacement segments. `{ segments: [] }` means
 * handled-with-no-output — distinct from `undefined` (unhandled).
 */
export interface ComponentHandling {
  segments: Segment[];
}

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

// Canonical draft-07 JSON Schema object (spec §5.1.1). Held as `JsonObject` so
// it doubles as a stable `WeakMap` key for the compiled-validator cache.
export type PropsSchema = JsonObject;

// A draft-07 JSON Schema object describing a component's return value. Unlike
// `PropsSchema` its root may describe any JSON value kind, not only an object.
export type ReturnsSchema = JsonObject;

export interface ComponentDefinition {
  kind: "markdown";
  name: string;
  path: string;
  meta: Record<string, unknown>;
  props: PropsSchema;
  /** Absent in text mode, where the component returns its rendered markdown. */
  returns?: ReturnsSchema;
  bodySegments: Segment[];
}

export interface ImportResult extends Record<string, Json> {
  path: string;
  content: string;
}

/**
 * One run of a component: durable-capable, and free to acquire runtime
 * resources that belong to the component invocation.
 *
 * Durable effects a component yields are journaled and replayed as usual,
 * because the engine runs it inside the document's durable routine. Ordinary
 * resources it acquires are released when the invocation ends — after the
 * content it projected has stopped (§4.4) — so a component that holds
 * something for its children needs no lifetime plumbing of its own.
 */
export type ComponentExecution<T> = Operation<T>;

/**
 * A TypeScript function component — a generator function that receives
 * validated props directly. A text component returns its rendered output as a
 * string; a component declaring `export const returns` returns the JSON value
 * validated against that schema.
 *
 * Invocation content is available contextually through `content()` — there is
 * no `children` prop:
 * ```ts
 * import { content } from "@executablemd/core";
 * export default function*(props) {
 *   const rendered = yield* content();
 *   return `<div>${rendered}</div>`;
 * }
 * ```
 *
 * That call is the component's failure boundary (spec §5.1.2): content that
 * fails to expand throws `ContentError` there instead of returning, so a
 * component validates its content before it acquires anything by calling
 * `content()` first. Catching `ContentError` around the call is explicit
 * recovery; uncaught, the invocation yields the original errors and the
 * generator's return value is never used. `useContent(slot?)` is a
 * compatibility alias with the same behavior.
 */
export interface FunctionComponent {
  (props: Record<string, Json>): ComponentExecution<Json>;
}

/**
 * Definition for a function component (.ts file).
 * Distinguished from ComponentDefinition by the `kind` field.
 */
export interface FunctionComponentDefinition {
  kind: "function";
  name: string;
  path: string;
  props: PropsSchema;
  returns?: ReturnsSchema;
  fn: FunctionComponent;
}

export interface ResolveResult {
  path: string;
}

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

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
 * Definition for a function component — a repository `.ts` file or a
 * registration. Distinguished from ComponentDefinition by the `kind` field.
 *
 * It carries no path. A registration is module-resident and names no file, and
 * a repository definition's source is already described by the
 * `ComponentSelection` that chose it, so source identity lives there rather
 * than being copied onto every definition (spec §5.3).
 */
/**
 * A function component whose return value is bound by reference rather than
 * rendered. Its value is never validated, serialized or rendered, so it is not
 * constrained to `Json` — and the consumer narrows it explicitly, exactly as
 * `capture()` makes the input side do.
 */
export interface LiveFunctionComponent {
  (props: Record<string, Json>): ComponentExecution<unknown>;
}

interface FunctionComponentDefinitionBase {
  kind: "function";
  name: string;
  props: PropsSchema;
  /** Props the engine leaves unresolved for the component to evaluate itself. */
  captures?: readonly string[];
}

/**
 * Declaring `liveReturn` changes what the component may return, so the two are
 * one choice rather than two independent fields: an ordinary definition returns
 * `Json` exactly as before, and a live one returns `unknown` and cannot also
 * declare `returns`. The pairing is in the type, so neither combination that
 * would be a contradiction is expressible.
 */
export type FunctionComponentDefinition =
  | (FunctionComponentDefinitionBase & {
      liveReturn?: false;
      returns?: ReturnsSchema;
      fn: FunctionComponent;
    })
  | (FunctionComponentDefinitionBase & {
      liveReturn: true;
      returns?: undefined;
      fn: LiveFunctionComponent;
    });

/**
 * An ordinary function-component invocation that failed (spec §6.9).
 *
 * Reported only after the invocation has finished being dismantled, so `error`
 * accounts for the body and its teardown together.
 */
export interface ComponentFailure {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  readonly error: Error;
}

/**
 * What a component's content rendered, and why it stopped if it did.
 *
 * `text` is everything produced before the stop, so a component reporting a
 * failure can show the work that led to it. `failure` is what the content threw
 * — absent when it finished. Error segments the content *collected* are part of
 * `text`, not a failure: they settled under the ambient policy already.
 */
export interface PartialContent {
  readonly text: string;
  readonly failure?: unknown;
}

/**
 * Where a function component was invoked (spec §5.5).
 *
 * A detached snapshot, not the element the parser built: a component learns
 * where it was written without reaching anything else about the invocation —
 * no props, no `as`, no content, no element.
 */
export interface ComponentInvocationMetadata {
  readonly name: string;
  /** Absent for markdown scanned at runtime, which has no source of its own. */
  readonly position?: Readonly<SourcePosition>;
}

/**
 * Where a selected implementation came from (spec §5.3).
 *
 * A registration names itself with a stable human-readable `origin` rather than
 * a filesystem path, because it has no file to name.
 */
export type ComponentOrigin =
  | { kind: "structural"; construct: string }
  | { kind: "repository"; path: string }
  | { kind: "registered"; origin: string; reserved: boolean };

/**
 * What resolving a name decided, before anything is loaded.
 *
 * Structural syntax selects no definition — it is engine-owned and never
 * reaches component import. A repository selection carries only the chosen
 * path: reading and parsing happen afterwards, inside the journal.
 */
export type ComponentSelection =
  | { kind: "structural"; construct: string }
  | { kind: "registered"; definition: FunctionComponentDefinition; origin: ComponentOrigin }
  | { kind: "repository"; path: string }
  | { kind: "unresolved"; searched: string[]; registered: readonly ComponentOrigin[] };

/** A registered implementation and the origin that named it. */
export interface Registered {
  definition: FunctionComponentDefinition;
  origin: string;
}

/**
 * Reserved and default registrations for one name are held apart so that
 * precedence comes from the resolver's tiers rather than from the order
 * registrations were installed in.
 */
export interface RegistryEntry {
  reserved?: Registered;
  default?: Registered;
}

export type ComponentRegistry = ReadonlyMap<string, RegistryEntry>;

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

/**
 * Core types for Executable MDX.
 *
 * Defines the Segment intermediate representation, component model types,
 * modifier system types, and shared interfaces.
 */

import type { Operation, Result } from "effection";
import type { Json as DurableJson } from "@executablemd/durable-streams";
import type { TestHarnessComponentDefinition } from "./test-harness.ts";

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
  /**
   * The authored text of `{…}` props the scanner could read as JSON and so
   * resolved into `props`.
   *
   * Scanning happens before a name resolves, so the scanner cannot know
   * whether the definition that will run declares the prop a capture. Reading
   * the text as JSON is a projection — a function, a class instance or a cycle
   * has no JSON shape at all — and a capture exists precisely to avoid one. Keeping the authored text beside
   * the projection lets expansion, which does know the selected definition,
   * hand a captured prop the exact value its expression produced and every
   * other prop the reading it has always had (§6.5).
   *
   * Only props written as an expression appear here. A quoted attribute is a
   * string the author wrote, not an expression, and is `props` either way.
   *
   * Optional, unlike `expressions`: this is the scanner's record of how a prop
   * was written, and an element built directly — by a test, or by a construct
   * assembling one — was not written anywhere. Absent means the same as empty.
   */
  authoredExpressions?: Record<string, string>;
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
  /**
   * The `as="name"` annotation the info string carried, if it carried one.
   *
   * A binding annotation is not middleware: it is removed before modifier
   * composition and names where this block's process outcome is bound (§3.6).
   * A malformed annotation is the failure it describes, decided before the
   * chain is composed and therefore before a process starts.
   */
  binding?: Result<string>;
  /**
   * Where the opening fence sits in the original file, frontmatter included.
   * Absent for dynamically scanned strings (render(markdown)).
   */
  position?: SourcePosition;
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

export interface ParsedInfoString {
  language: string;
  modifiers: Modifier[];
  executable: boolean;
  /** The binding annotation the info string carried, if it carried one. */
  binding?: Result<string>;
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
  /**
   * Where this block's foreground output goes, decided where the block sits.
   *
   * Carried by value because the structure that decides it — a `<Let as>`
   * region — is lexical to expansion, while the block runs inside the durable
   * routine. The block context is what already crosses that boundary intact.
   */
  routing?: import("./foreground.ts").ForegroundRouting;
  /**
   * Where the block was written, carried for the journal rather than for
   * execution. The durable record of an authored block says where it came from,
   * and the block context is what already crosses into the durable routine.
   */
  position?: Readonly<SourcePosition>;
}

export interface CodeBlockResult {
  output: string;
  exitCode: number;
  stderr: string;
  /**
   * The process outcome a bound block binds. Absent unless the block carried
   * an `as="name"` annotation; `output` is rendering transport and is never
   * the binding.
   */
  bound?: ExecResult;
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
  (props: Record<string, Json>, invocation: ComponentInvocation): ComponentExecution<unknown>;
}

/**
 * What the engine tells a function component about the invocation it is in.
 *
 * Handed as an argument rather than published anywhere, because this is what a
 * component names a durable operation after. Every other channel into an
 * invocation is composable: a Context is addressed by name, so a loaded
 * component may bind one for its descendants, and a contextual Api handler
 * installed by an ancestor answers ahead of the engine's own. An argument
 * passed at the call site is neither — the engine hands this to the exact
 * implementation it resolved, and nothing sits between them (Code Rule 15).
 *
 * A component that does not need it declares one parameter and never sees it.
 */
export interface ComponentInvocation {
  /**
   * This invocation's durable identity — the same value `getExpansion()`
   * reports, from a channel a document cannot substitute.
   */
  readonly id: string;
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
export interface FunctionComponentDefinition {
  kind: "function";
  name: string;
  props: PropsSchema;
  /** Props the engine leaves unresolved for the component to evaluate itself. */
  captures?: readonly string[];
  /**
   * Opt-in validation: this return is a validated JSON record, bound under
   * `as` after checking. Without it a return binds by reference, unchecked.
   */
  returns?: ReturnsSchema;
  fn: FunctionComponent | TestHarnessComponentDefinition;
}

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
  /**
   * Whose work failed. `"content"` is the content the caller wrote and this
   * invocation projected, which the component neither authored nor recovered
   * from; anything else is the component's own. A `printErrors(fn)` declaration
   * speaks for the component, so it decides the second and delegates the first
   * to the region the content is written in (§6.8.1).
   */
  readonly origin?: "content";
}

/**
 * What a component's content rendered, and why it stopped if it did.
 *
 * `text` is everything produced before the stop, so a component reporting a
 * failure can show the work that led to it. `failure` is what the content threw
 * — absent when it finished. Error segments the content *printed* are part of
 * `text`, not a failure: they settled under the ambient error mode already.
 */
export interface PartialContent {
  readonly text: string;
  readonly failure?: unknown;
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
  /**
   * A component the workflow definition is closed over, with the exact source
   * the pinned tree holds. Nothing was read from the filesystem to answer this.
   */
  | { kind: "workflow"; path: string; sourceHash: string; content: string }
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

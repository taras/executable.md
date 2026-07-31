/**
 * Component Api — contextual operations for component expansion.
 *
 * One public Api replaces the former dependency container (ExpansionContext)
 * and raw Effection context keys. Context-dependent behavior is installed as
 * scope-local middleware via `Component.around(...)`:
 *
 * - Runtime implementations (document import, modifier execution, component
 *   state) install at `{ at: "min" }`. Middleware installed in a nested scope
 *   runs before inherited middleware, so a component that installs its own
 *   `env` shadows its ancestors without leaking into siblings — install
 *   inside `scoped()` for automatic removal.
 * - Caller instrumentation and overrides wrap at the default `"max"`.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { EvalScope } from "@effectionx/scope-eval";
import { settle } from "./errors.ts";
import type {
  CodeBlockContext,
  CodeBlockResult,
  ComponentDefinition,
  ComponentElement,
  ComponentHandling,
  ComponentFailure,
  ComponentInvocationMetadata,
  ComponentRegistry,
  PartialContent,
  ErrorSegment,
  EvalEnv,
  FunctionComponentDefinition,
  Modifier,
  Segment,
} from "./types.ts";

/**
 * The engine's segment expansion, already bound to one expansion's
 * interpolation inputs, cycle-detection hide set, and block counter. The
 * expansion loop sets it around each element it offers to extensions and
 * restores the enclosing one afterwards, so a claiming handler recurses with
 * that expansion's state and nothing else in the run sees one at all.
 * Internal: extensions reach it through `Component.expandSegments`.
 */
export const ExpansionFrame: Context<((segments: Segment[]) => Operation<Segment[]>) | undefined> =
  createContext<((segments: Segment[]) => Operation<Segment[]>) | undefined>(
    "component.expansionFrame",
    undefined,
  );

export interface ComponentApi {
  /** `"__root__"` imports the root document. */
  importComponent(name: string): Operation<ComponentDefinition | FunctionComponentDefinition>;
  applyModifiers(modifiers: Modifier[], block: CodeBlockContext): Operation<CodeBlockResult>;
  /**
   * Report an ErrorSegment under the ambient error policy (spec §6.9).
   *
   * The middleware chain is the observation chain — a segment passes through it
   * once, where it is created. The default implementation settles it under
   * `AmbientErrorPolicy`: collected for rendering, or thrown inside
   * suppressed documentation.
   *
   * Whoever creates an ErrorSegment calls this, including an `expand` handler.
   * A segment that reaches the document without it never passes the chain, so
   * middleware that counts, logs, or forwards failures never sees it.
   */
  raise(error: ErrorSegment): Operation<ErrorSegment>;
  env: EvalEnv | undefined;
  evalScope: EvalScope | undefined;
  /**
   * Offer a component element to extensions before built-in expansion.
   * Extensions install middleware that returns `{ segments }` for the names
   * they claim and delegates to `next` for everything else. The default
   * answers `undefined` — unhandled — so expansion proceeds normally.
   *
   * A handler owns the observation of every ErrorSegment it creates: it calls
   * `raise` for its own diagnostics — an invalid prop, a structural violation —
   * and returns errors that came back from `expandSegments` untouched, because
   * those were already reported where they were produced. The engine settles
   * whatever is returned under the caller's ambient policy, so a collecting
   * caller keeps the error and a throwing one aborts, either way without a
   * second observation. Returning a diagnostic the handler created but never
   * raised bypasses the observation chain and breaks this contract.
   */
  expand(element: ComponentElement): Operation<ComponentHandling | undefined>;
  /**
   * Expand segments within the expansion that offered the current element:
   * the engine's own recursion, already bound to that expansion's
   * interpolation inputs, cycle-detection state, and block-ID counter. A
   * handler uses it for an element's children or for segments it generates.
   *
   * Live for exactly one `expand` offer, so it answers only inside the handler
   * that received the element. Ordinary expansion work — a code block, a
   * modifier chain, a task that outlives the offer — finds no active expansion
   * and gets an error.
   *
   * Every ErrorSegment among the returned segments has already been reported
   * through `raise`, at the point inside the expansion that produced it. A
   * handler passes them on as they are; raising one again would report the same
   * failure twice.
   */
  expandSegments(segments: Segment[]): Operation<Segment[]>;
  codeBlock(): Operation<CodeBlockContext>;
  /** Whether the current block runs with persistent resource lifetime. */
  persistent: boolean;
  /**
   * Render the content the invoking component was written with — the default
   * content, or a named slot (spec §5.1.2). This is the canonical operation for
   * a function component; `useContent(slot?)` is a compatibility alias for it.
   *
   * Each call is a failure boundary. Requested content that expands cleanly
   * comes back as its rendered string. Requested content that produces
   * ErrorSegments throws `ContentError` carrying those original segments, so
   * normal continuation stops at the `yield* content()` expression: the
   * component's return is not processed and no `as` binding is made. Left
   * uncaught, the invocation is replaced by the original errors under a
   * collecting policy, or the original `DocumentationError` is restored under a
   * throwing one.
   *
   * Catching `ContentError` around the call is explicit recovery — the
   * component chooses what to render instead, and its consumer never sees the
   * failure. Only content the component asks for is expanded.
   */
  content(slot?: string): Operation<string>;
  /** Whether the invoking element was written with content rather than self-closed. */
  hasContent(): Operation<boolean>;
  /**
   * Create a resource owned by the scope that invoked this component
   * (spec §4.4).
   *
   * The factory runs in an isolated child of the invocation-site eval scope,
   * so what it acquires lives as long as that scope does — staying alive after
   * the component returns and released when the site succeeds, fails, or is
   * cancelled — while context and middleware it installs stay inside the
   * child. Only the provided value crosses back, and neither scope is handed
   * out: retention is a lifetime, not authority over the caller.
   *
   * This is an operation of TypeScript component execution. Eval blocks are
   * durable — a replay restores a block's exported values without running its
   * executor — so retaining from one would leave a restored value pointing at
   * a resource that was never re-established. Eval execution installs a
   * provider that rejects the call rather than letting it succeed.
   */
  retain<T>(resource: () => Operation<T>): Operation<T>;
  /**
   * Where this function component was invoked (spec §5.5).
   *
   * Available only while the component runs. A nested invocation shadows it and
   * the enclosing one is restored on the way out, so what a component reads is
   * always its own call site.
   */
  invocation(): Operation<ComponentInvocationMetadata>;
  /**
   * Render the invoking component's content, reporting a failure instead of
   * replacing the invocation with it.
   *
   * `content()` is the failure boundary and stays the ordinary way to ask. This
   * is for a component that renders something *in place of* the failure — a
   * test report — and so needs both what rendered before the stop and why it
   * stopped. It hands back text and a reason, never segments: there is no
   * recursion here and no reaching into the caller.
   */
  tryContent(slot?: string): Operation<PartialContent>;
  /**
   * Decide what an ordinary function-component failure means (spec §6.9).
   *
   * Called only after `withInvocation()` has dismantled the invocation, so the
   * failure it is handed accounts for the body and its teardown together. The
   * default fails the operation, which is what an ordinary Effection failure
   * does; a collection boundary answers with a diagnostic instead.
   *
   * Distinct from `raise`: this handles an operation failure, while `raise`
   * observes an `ErrorSegment`. A collector uses both — it converts, then
   * observes exactly once.
   */
  handleFailure(failure: ComponentFailure): Operation<ErrorSegment>;
  /**
   * Components made resolvable by name for this scope (spec §5.3).
   *
   * Install with `registerComponents()` rather than by hand: each accepted
   * batch adds one immutable layer that merges over what it inherited, so a
   * nested registration shadows an outer one without changing it.
   *
   * Core's own components are not here. They are the terminal of
   * `selectComponent()`, which both execution and inspection resolve through,
   * so what this holds is only what a host or package added.
   */
  registry: ComponentRegistry;
}

export const Component: Api<ComponentApi> = createApi<ComponentApi>("Component", {
  // deno-lint-ignore require-yield
  *importComponent(name: string): Operation<ComponentDefinition | FunctionComponentDefinition> {
    throw new Error(
      `Component.importComponent("${name}") has no provider. Install one with ` +
        `Component.around({ importComponent }, { at: "min" }) before expansion.`,
    );
  },
  // deno-lint-ignore require-yield
  *applyModifiers(_modifiers: Modifier[], block: CodeBlockContext): Operation<CodeBlockResult> {
    throw new Error(
      `Component.applyModifiers() has no provider for block "${block.blockId}". Install one ` +
        `with Component.around({ applyModifiers }, { at: "min" }) before expansion.`,
    );
  },
  *raise(error: ErrorSegment): Operation<ErrorSegment> {
    return yield* settle(error);
  },
  env: undefined,
  evalScope: undefined,
  // deno-lint-ignore require-yield
  *expand(): Operation<ComponentHandling | undefined> {
    return undefined;
  },
  *expandSegments(segments: Segment[]): Operation<Segment[]> {
    const frame = yield* ExpansionFrame.get();
    if (!frame) {
      throw new Error(
        "Component.expandSegments() has no active expansion in this scope. It is available " +
          "to a Component.around({ expand }) handler, for the element it was offered.",
      );
    }
    return yield* frame(segments);
  },
  // deno-lint-ignore require-yield
  *codeBlock(): Operation<CodeBlockContext> {
    throw new Error(
      "Component.codeBlock() has no provider: no code block is executing in this scope.",
    );
  },
  persistent: false,
  /**
   * Calling for content outside an invocation is a mistake in the caller, not a
   * content failure, so this is an ordinary Error: a component's
   * `catch (error) { if (error instanceof ContentError) … }` does not absorb it.
   */
  // deno-lint-ignore require-yield
  *content(_slot?: string): Operation<string> {
    throw new Error(
      "Component.content() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *hasContent(): Operation<boolean> {
    throw new Error(
      "Component.hasContent() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *retain<T>(_resource: () => Operation<T>): Operation<T> {
    throw new Error("Component.retain() has no provider: not inside a component invocation.");
  },
  // deno-lint-ignore require-yield
  *invocation(): Operation<ComponentInvocationMetadata> {
    throw new Error(
      "Component.invocation() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *tryContent(_slot?: string): Operation<PartialContent> {
    throw new Error(
      "Component.tryContent() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *handleFailure(failure: ComponentFailure): Operation<ErrorSegment> {
    throw failure.error;
  },
  registry: new Map(),
});

export const importComponent: Operations<ComponentApi>["importComponent"] =
  Component.operations.importComponent;
export const applyModifiers: Operations<ComponentApi>["applyModifiers"] =
  Component.operations.applyModifiers;
export const raise: Operations<ComponentApi>["raise"] = Component.operations.raise;
export const env: Operations<ComponentApi>["env"] = Component.operations.env;
export const evalScope: Operations<ComponentApi>["evalScope"] = Component.operations.evalScope;
export const expand: Operations<ComponentApi>["expand"] = Component.operations.expand;
export const expandSegments: Operations<ComponentApi>["expandSegments"] =
  Component.operations.expandSegments;
export const codeBlock: Operations<ComponentApi>["codeBlock"] = Component.operations.codeBlock;
export const persistent: Operations<ComponentApi>["persistent"] = Component.operations.persistent;
export const content: Operations<ComponentApi>["content"] = Component.operations.content;
export const hasContent: Operations<ComponentApi>["hasContent"] = Component.operations.hasContent;
export const retain: Operations<ComponentApi>["retain"] = Component.operations.retain;
export const registry: Operations<ComponentApi>["registry"] = Component.operations.registry;
export const invocation: Operations<ComponentApi>["invocation"] = Component.operations.invocation;
export const tryContent: Operations<ComponentApi>["tryContent"] = Component.operations.tryContent;
export const handleFailure: Operations<ComponentApi>["handleFailure"] =
  Component.operations.handleFailure;

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
   */
  raise(error: ErrorSegment): Operation<ErrorSegment>;
  env: EvalEnv | undefined;
  evalScope: EvalScope | undefined;
  /**
   * Offer a component element to extensions before built-in expansion.
   * Extensions install middleware that returns `{ segments }` for the names
   * they claim and delegates to `next` for everything else. The default
   * answers `undefined` — unhandled — so expansion proceeds normally.
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
   */
  expandSegments(segments: Segment[]): Operation<Segment[]>;
  codeBlock(): Operation<CodeBlockContext>;
  /** Whether the current block runs with persistent resource lifetime. */
  persistent: boolean;
  /** Render the invoking component's children (optionally a named slot). */
  content(slot?: string): Operation<string>;
  /** Whether the invoking element was written with content rather than self-closed. */
  hasContent(): Operation<boolean>;
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

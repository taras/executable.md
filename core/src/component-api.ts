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
import type { Operation } from "effection";
import type { EvalScope } from "@effectionx/scope-eval";
import type {
  CodeBlockContext,
  CodeBlockResult,
  ComponentDefinition,
  ComponentInvocation,
  ErrorSegment,
  EvalEnv,
  FunctionComponentDefinition,
  InvocationContext,
  InvocationHandling,
  Modifier,
} from "./types.ts";

export interface ComponentApi {
  /** `"__root__"` imports the root document. */
  importComponent(name: string): Operation<ComponentDefinition | FunctionComponentDefinition>;
  applyModifiers(modifiers: Modifier[], block: CodeBlockContext): Operation<CodeBlockResult>;
  /**
   * Report an ErrorSegment under the ambient error policy. The default
   * returns the segment for rendering; suppressed-documentation scopes
   * install middleware that throws instead (spec §6.9).
   */
  raise(error: ErrorSegment): Operation<ErrorSegment>;
  env: EvalEnv | undefined;
  evalScope: EvalScope | undefined;
  /**
   * Offer a raw component invocation to extensions before built-in expansion.
   * Extensions install middleware that returns `{ segments }` for the names
   * they claim and delegates to `next` for everything else. The default
   * answers `undefined` — unhandled — so expansion proceeds normally.
   */
  expandInvocation(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<InvocationHandling | undefined>;
  codeBlock(): Operation<CodeBlockContext>;
  /** Whether the current block runs with persistent resource lifetime. */
  persistent: boolean;
  /** Render the invoking component's children (optionally a named slot). */
  content(slot?: string): Operation<string>;
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
  // deno-lint-ignore require-yield
  *raise(error: ErrorSegment): Operation<ErrorSegment> {
    return error;
  },
  env: undefined,
  evalScope: undefined,
  // deno-lint-ignore require-yield
  *expandInvocation(): Operation<InvocationHandling | undefined> {
    return undefined;
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
});

export const importComponent: Operations<ComponentApi>["importComponent"] =
  Component.operations.importComponent;
export const applyModifiers: Operations<ComponentApi>["applyModifiers"] =
  Component.operations.applyModifiers;
export const raise: Operations<ComponentApi>["raise"] = Component.operations.raise;
export const env: Operations<ComponentApi>["env"] = Component.operations.env;
export const evalScope: Operations<ComponentApi>["evalScope"] = Component.operations.evalScope;
export const expandInvocation: Operations<ComponentApi>["expandInvocation"] =
  Component.operations.expandInvocation;
export const codeBlock: Operations<ComponentApi>["codeBlock"] = Component.operations.codeBlock;
export const persistent: Operations<ComponentApi>["persistent"] = Component.operations.persistent;
export const content: Operations<ComponentApi>["content"] = Component.operations.content;

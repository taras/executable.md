/**
 * How an ordinary code block is executed, as the running execution offers it.
 *
 * There are two ways into a modifier chain, and they need different things.
 *
 * Canonical expansion runs a block through a per-block descriptor whose
 * *instance default* composes the chain (`execute.ts`). That default is the only
 * thing that ever holds an assertion projection, and it is instance-owned
 * precisely so no installed handler can preempt it — an engine terminal
 * installed as middleware would answer ahead of an inherited `{ at: "min" }`
 * handler and take that handler's refusal and override rights away.
 *
 * A TypeScript component may also call the public `applyModifiers()` itself
 * (spec §5.5). That call arrives at the *exported* descriptor's default, which
 * is shared by every caller and can close over nothing. So the execution offers
 * what only it has — its modifier registry — through this Api, and the exported
 * default asks for it here.
 *
 * ## What this is, and what it is not
 *
 * Composition, not authority. The operation takes an ordinary modifier array and
 * an ordinary block context, and it is never handed a projection: a direct call
 * composes an ordinary chain with no privileged terminal, so a block run this
 * way reads whatever ordinary environment composition produced, whether or not
 * an assertion projection happens to be active around the component that made
 * the call. Replacing this provider therefore reaches ordinary block execution —
 * which the public `applyModifiers()` already was — and reaches no nested
 * execution, no completion, and no projection.
 *
 * The name is stable and namespaced on purpose. A separately loaded copy of core
 * has its own descriptor object but resolves the same name, so a component
 * calling *that* copy's `applyModifiers()` still reaches the runner the active
 * execution installed. String keying is what makes a capability portable across
 * copies; nothing here is a capability, which is why keying it that way is safe.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { CodeBlockContext, CodeBlockResult, Modifier } from "./types.ts";

export interface ModifierRunnerApi {
  /**
   * Compose and run one ordinary block against the running execution's registry.
   *
   * Reached only from the exported `Component.applyModifiers` default, and only
   * after every public handler has composed — so this runs the chain once, and
   * never invokes `Component.applyModifiers` again.
   */
  invoke(modifiers: Modifier[], context: CodeBlockContext): Operation<CodeBlockResult>;
}

export const ModifierRunner: Api<ModifierRunnerApi> = createApi<ModifierRunnerApi>(
  "@executablemd/core:ModifierRunner",
  {
    /**
     * No execution is running, so there is no registry to compose against.
     *
     * The sentence is the one the public operation has always answered with,
     * because this is the same condition reported from one step further in: a
     * caller outside an execution, or inside one whose host installed nothing.
     */
    // deno-lint-ignore require-yield
    *invoke(_modifiers: Modifier[], context: CodeBlockContext): Operation<CodeBlockResult> {
      throw new Error(
        `Component.applyModifiers() has no provider for block "${context.blockId}". Install one ` +
          `with Component.around({ applyModifiers }, { at: "min" }) before expansion.`,
      );
    },
  },
);

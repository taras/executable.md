/**
 * Content context for function components.
 *
 * Provides `useContent()` — the function component equivalent of
 * `<Content />` in markdown components. The expansion engine sets
 * the content handle on the Effection scope before calling the
 * function component. Components that need rendered children call
 * `yield* useContent()` to retrieve them.
 *
 * Named slots are supported: `yield* useContent("header")` returns
 * the content for the "header" slot, matching `<Content slot="header" />`
 * in markdown components.
 */

import { createContext } from "effection";
import type { Operation } from "effection";
import type { Segment } from "./types.ts";

/**
 * Handle providing access to a component's children content.
 * Set on the Effection scope by the expansion engine.
 */
export interface ContentHandle {
  /** Render the default slot (children without a slot prop). */
  renderDefault: () => Operation<string>;
  /** Render a named slot. Returns empty string if the slot has no content. */
  renderSlot: (name: string) => Operation<string>;
  /** Raw child segments (all slots combined, for inspection). */
  segments: Segment[];
}

/**
 * Effection context key for the content handle.
 */
export const ContentCtx = createContext<ContentHandle>("content");

/**
 * Render children content from the parent scope.
 *
 * The function component equivalent of `<Content />` in markdown components.
 *
 * @param slotName - Optional slot name. If provided, renders only the
 *   content assigned to that slot. If omitted, renders the default slot
 *   (children without a `slot` prop).
 * @returns The rendered content as a string.
 *
 * @example
 * ```ts
 * // Render default content (equivalent to <Content /> in .md)
 * const content = yield* useContent();
 *
 * // Render named slot (equivalent to <Content slot="header" /> in .md)
 * const header = yield* useContent("header");
 * ```
 */
export function* useContent(slotName?: string): Operation<string> {
  const handle = yield* ContentCtx.expect();
  if (slotName !== undefined) {
    return yield* handle.renderSlot(slotName);
  }
  return yield* handle.renderDefault();
}

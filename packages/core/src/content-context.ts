/**
 * What a function component asks about the content it was invoked with.
 *
 * `useContent()` is the function component equivalent of `<Content />` in
 * markdown components; `hasContent()` answers whether there is any to render.
 * Both are ergonomic aliases for Component operations the expansion engine
 * installs around each function component invocation.
 */

import type { Operation } from "effection";
import { content, hasContent as componentHasContent } from "./component-api.ts";

/**
 * Render children content from the invoking component.
 *
 * @param slotName - Optional slot name. If provided, renders only the
 *   content assigned to that slot (matching `<Content slot="name" />`).
 *   If omitted, renders the default slot.
 *
 * @example
 * ```ts
 * const body = yield* useContent();
 * const header = yield* useContent("header");
 * ```
 */
export function useContent(slotName?: string): Operation<string> {
  return content(slotName);
}

/**
 * Whether the invocation was written with content: `<C>…</C>` and `<C></C>`
 * have content, `<C />` does not.
 *
 * This is the shape of the invocation, not a prediction about what it renders:
 * content that renders an empty string still counts. A component whose two
 * forms mean different things — a wrapper versus a standalone allocation —
 * branches on this rather than on the rendered result.
 *
 * @example
 * ```ts
 * if (yield* hasContent()) {
 *   return yield* useContent();
 * }
 * ```
 */
export function hasContent(): Operation<boolean> {
  return componentHasContent();
}

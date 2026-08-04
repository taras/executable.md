/**
 * Compatibility aliases for what a function component asks about the content it
 * was invoked with.
 *
 * `content(slot?)` from `component-api.ts` is the canonical operation — the
 * function component equivalent of `<Content />` in markdown components, and
 * the failure boundary for the content it renders (spec §5.1.2). `useContent()`
 * stays supported and delegates to it unchanged, including its `ContentError`
 * semantics. `hasContent()` answers whether there is any content to render.
 *
 * Both alias Component operations the expansion engine installs around each
 * function component invocation. The `useContent` binding injected into eval
 * blocks is a different, mode-carrying closure (spec §4.3), not this alias.
 */

import type { Operation } from "effection";
import { content, hasContent as componentHasContent } from "./component-api.ts";

/**
 * Render the invoking component's content — the compatibility alias for
 * `content(slot?)`, which new components import directly.
 *
 * Behaves identically: the requested content comes back as a rendered string,
 * and content that fails to expand throws `ContentError` at this call rather
 * than returning (spec §5.1.2).
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
 *   return yield* content();
 * }
 * ```
 */
export function hasContent(): Operation<boolean> {
  return componentHasContent();
}

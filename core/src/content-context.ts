/**
 * useContent() — the function component equivalent of `<Content />` in
 * markdown components. Ergonomic alias for the Component `content()`
 * operation; the expansion engine installs the slot-rendering middleware
 * around each function component invocation.
 */

import type { Operation } from "effection";
import { content } from "./component-api.ts";

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
export function* useContent(slotName?: string): Operation<string> {
  return yield* content(slotName);
}

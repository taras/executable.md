/**
 * `<Test>` — the construct whose invocation contains a checked failure (§3.6).
 *
 * This function is the whole of core's claim. It is private to this module in
 * every sense that matters: it is never registered by another package, never
 * handed to an installation, never named in an option, and never reachable
 * through the public surface. `expandFunctionComponent` grants containment to
 * the definition it is expanding when that definition is this one, so what may
 * contain a checked command failure is decided by canonical core and by
 * nothing else.
 *
 * It is an ordinary **default**, like every other component in the core
 * registry: a repository `Test.md` or `Test.ts` is chosen ahead of it, and so
 * is any package that registers the name. When one of those is selected this
 * definition was not, so it is not this function that runs and no containment
 * is granted — which is the point of deciding by definition rather than by
 * name (specs/testing-spec.md).
 *
 * What a test *does* is not here. That arrives through `TestBehavior`.
 */

import type { Operation } from "effection";
import { TestBehavior } from "../test-behavior.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: { name: { type: "string" }, timeout: { type: "string" } },
  additionalProperties: false,
};

export default function* Test(props: Record<string, Json>): Operation<Json> {
  return yield* TestBehavior.operations.test(props);
}
